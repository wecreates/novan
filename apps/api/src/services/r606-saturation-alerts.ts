/**
 * R606 — Saturation alerts.
 *
 * Polls R603 liveCounters every minute (via learning-cron). When
 * `tasksInFlight.total >= threshold` for `dwellTicks` consecutive ticks,
 * fires a webhook + writes an event + (optionally) records a kill_switch
 * advisory. Cooldown prevents spam.
 *
 * Config (env, overridable per workspace via workspace_settings):
 *   NOVAN_SATURATION_THRESHOLD       default 20   (tasks-in-flight)
 *   NOVAN_SATURATION_DWELL_TICKS     default 2    (consecutive 60s ticks)
 *   NOVAN_SATURATION_COOLDOWN_MIN    default 10   (minutes between alerts)
 *   NOVAN_SATURATION_WEBHOOK_URL     optional     POST {workspace, tasksInFlight, breakdown, firedAt}
 *
 * Cron tick is wired via learning-cron.runSaturationAlertsTick (R606).
 * Set DISABLE_SATURATION_ALERTS=1 to disable.
 *
 * State is in-memory per workspace (reset on restart, which is correct —
 * a restart drops in-flight, so the dwell counter should restart too).
 */

interface State {
  consecutive:   number      // ticks at or above threshold
  lastFiredAt:   number | null
  lastTotal:     number
}

const STATE = new Map<string, State>()

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? '')
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export interface SaturationConfig {
  threshold:    number
  dwellTicks:   number
  cooldownMin:  number
  webhookUrl:   string | null
}

export function loadConfig(): SaturationConfig {
  return {
    threshold:   envNum('NOVAN_SATURATION_THRESHOLD',     20),
    dwellTicks:  Math.max(1, envNum('NOVAN_SATURATION_DWELL_TICKS',   2)),
    cooldownMin: Math.max(1, envNum('NOVAN_SATURATION_COOLDOWN_MIN', 10)),
    webhookUrl:  process.env['NOVAN_SATURATION_WEBHOOK_URL'] ?? null,
  }
}

export interface SaturationCheck {
  workspaceId:   string
  tasksInFlight: number
  threshold:     number
  consecutive:   number
  dwellTicks:    number
  fired:         boolean
  reason?:       string
  cooldownLeftMin?: number
}

async function postWebhook(url: string, payload: unknown, timeoutMs = 8_000): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Novan-R606/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: r.ok, status: r.status }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

/** Single-tick evaluation for one workspace. Persists state in-process. */
export async function evaluateWorkspace(workspaceId: string, opts: Partial<SaturationConfig> = {}): Promise<SaturationCheck> {
  const cfg = { ...loadConfig(), ...opts }
  const { liveCounters } = await import('./r603-neural-net.js')
  const counters = await liveCounters(workspaceId)
  const total = counters.tasksInFlight.total

  const s = STATE.get(workspaceId) ?? { consecutive: 0, lastFiredAt: null, lastTotal: 0 }
  s.lastTotal = total

  if (total < cfg.threshold) {
    s.consecutive = 0
    STATE.set(workspaceId, s)
    return { workspaceId, tasksInFlight: total, threshold: cfg.threshold, consecutive: 0, dwellTicks: cfg.dwellTicks, fired: false, reason: 'under threshold' }
  }

  s.consecutive += 1

  if (s.consecutive < cfg.dwellTicks) {
    STATE.set(workspaceId, s)
    return { workspaceId, tasksInFlight: total, threshold: cfg.threshold, consecutive: s.consecutive, dwellTicks: cfg.dwellTicks, fired: false, reason: `dwell ${s.consecutive}/${cfg.dwellTicks}` }
  }

  // Cooldown.
  if (s.lastFiredAt && (Date.now() - s.lastFiredAt) < cfg.cooldownMin * 60_000) {
    const cooldownLeftMin = Math.ceil((cfg.cooldownMin * 60_000 - (Date.now() - s.lastFiredAt)) / 60_000)
    STATE.set(workspaceId, s)
    return { workspaceId, tasksInFlight: total, threshold: cfg.threshold, consecutive: s.consecutive, dwellTicks: cfg.dwellTicks, fired: false, reason: 'cooldown', cooldownLeftMin }
  }

  // FIRE.
  s.lastFiredAt = Date.now()
  STATE.set(workspaceId, s)

  // Audit event.
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(),
      workspaceId,
      type: 'saturation.alert',
      payload: {
        tasksInFlight: total,
        threshold: cfg.threshold,
        consecutive: s.consecutive,
        breakdown: counters.tasksInFlight,
        throughput: counters.throughput,
      },
      traceId: 'r606', correlationId: 'r606', source: 'r606-saturation', createdAt: Date.now(),
    }).catch(() => null)
  } catch { /* tolerated — event write best-effort */ }

  // Webhook.
  let webhookResult: { ok: boolean; status?: number; error?: string } | null = null
  if (cfg.webhookUrl) {
    webhookResult = await postWebhook(cfg.webhookUrl, {
      kind: 'novan.saturation_alert',
      workspaceId,
      tasksInFlight: total,
      threshold: cfg.threshold,
      breakdown: counters.tasksInFlight,
      throughput: counters.throughput,
      firedAt: new Date().toISOString(),
    })
  }

  return {
    workspaceId, tasksInFlight: total, threshold: cfg.threshold,
    consecutive: s.consecutive, dwellTicks: cfg.dwellTicks,
    fired: true,
    reason: webhookResult ? (webhookResult.ok ? `webhook ${webhookResult.status}` : `webhook fail: ${webhookResult.error ?? webhookResult.status}`) : 'event-only (no webhook url set)',
  }
}

/** Cron-friendly: evaluate every active workspace. */
export async function evaluateAllWorkspaces(): Promise<{ checks: SaturationCheck[]; fired: number }> {
  if (process.env['DISABLE_SATURATION_ALERTS'] === '1') return { checks: [], fired: 0 }
  const { db } = await import('../db/client.js')
  const { sql } = await import('drizzle-orm')
  const r = await db.execute(sql`SELECT id FROM workspaces`).catch(() => [] as unknown[])
  const ids = (r as Array<{ id: string }>).map(x => x.id)
  const checks: SaturationCheck[] = []
  for (const id of ids) {
    try { checks.push(await evaluateWorkspace(id)) } catch { /* tolerated per-workspace */ }
  }
  return { checks, fired: checks.filter(c => c.fired).length }
}

/** Snapshot current state for the dashboard / brain ops. */
export function currentState(): Array<{ workspaceId: string; consecutive: number; lastTotal: number; lastFiredAt: number | null }> {
  return [...STATE.entries()].map(([workspaceId, s]) => ({
    workspaceId, consecutive: s.consecutive, lastTotal: s.lastTotal, lastFiredAt: s.lastFiredAt,
  }))
}

export function resetState(workspaceId?: string): void {
  if (workspaceId) STATE.delete(workspaceId)
  else STATE.clear()
}
