/**
 * notifications.ts — Outbound notification dispatcher.
 *
 * Drivers (real HTTP calls, fail-fast when keys missing):
 *   - webhook   any URL, generic JSON body              (NOTIFY_WEBHOOK_URL)
 *   - pushover  https://pushover.net                    (PUSHOVER_TOKEN + PUSHOVER_USER)
 *   - slack     incoming webhook                        (SLACK_WEBHOOK_URL)
 *   - discord   incoming webhook                        (DISCORD_WEBHOOK_URL)
 *
 * Dispatch policy:
 *   - severity 'critical' → all configured drivers
 *   - severity 'high'     → all configured drivers
 *   - severity 'normal'   → webhook only (least noisy)
 *
 * In-process rate limit: same (workspace, type, signature) collapsed
 * within 5 min so kill_switches don't spam phones.
 * No keys configured → returns sent: [] (observable, not fake).
 */
import { db }                          from '../db/client.js'
import { events }                      from '../db/schema.js'
import { fetchWithRetry }              from './provider-retry.js'
import { v7 as uuidv7 }                from 'uuid'
import { and, eq, gte, desc, sql }     from 'drizzle-orm'
import { shouldNotifyOperator, type LoadMode } from './strategic-restraint.js'

export type NotifySeverity = 'normal' | 'high' | 'critical'

export interface NotifyInput {
  workspaceId: string
  type:        string             // e.g. 'governance.auto_throttle_engaged'
  title:       string
  body:        string
  severity:    NotifySeverity
  signature?:  string             // for rate-limit dedup; defaults to title
  link?:       string             // optional deep-link
}

export interface NotifyOptions {
  /** Skip the strategic-restraint pre-flight gate (use when caller has
   *  already evaluated load/deduping themselves). */
  bypassRestraint?: boolean
}

export interface NotifyResult {
  sent:    string[]               // drivers that succeeded
  skipped: string[]               // drivers that fired but had no key
  failed:  Array<{ driver: string; error: string }>
  rateLimited: boolean
  /** True when the restraint gate suppressed this notification. */
  suppressed?:       boolean
  suppressedReason?: string
}

const RATE_LIMIT_WINDOW_MS = 5 * 60_000
const RATE_LIMIT_MAP = new Map<string, number>()

function checkRateLimit(workspaceId: string, type: string, signature: string): boolean {
  const key = `${workspaceId}|${type}|${signature}`
  const last = RATE_LIMIT_MAP.get(key)
  if (last && Date.now() - last < RATE_LIMIT_WINDOW_MS) return true
  RATE_LIMIT_MAP.set(key, Date.now())
  return false
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

async function sendWebhook(input: NotifyInput): Promise<void> {
  const url = process.env['NOTIFY_WEBHOOK_URL']
  if (!url) throw new Error('NOTIFY_WEBHOOK_URL not set')
  const out = await fetchWithRetry('notify:webhook', url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace_id: input.workspaceId,
      type:         input.type,
      severity:     input.severity,
      title:        input.title,
      body:         input.body,
      link:         input.link ?? null,
      sent_at:      new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!out.ok) throw new Error(`Webhook ${out.status}: ${out.statusText}`)
}

async function sendPushover(input: NotifyInput): Promise<void> {
  const token = process.env['PUSHOVER_TOKEN']
  const user  = process.env['PUSHOVER_USER']
  if (!token || !user) throw new Error('PUSHOVER_TOKEN / PUSHOVER_USER not set')
  const priority = input.severity === 'critical' ? 1 : input.severity === 'high' ? 0 : -1
  const form = new URLSearchParams({
    token, user, title: input.title.slice(0, 250),
    message: input.body.slice(0, 1024),
    priority: String(priority),
    ...(input.link ? { url: input.link } : {}),
  })
  const out = await fetchWithRetry('notify:pushover', 'https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(10_000),
  })
  if (!out.ok) throw new Error(`Pushover ${out.status}: ${out.statusText}`)
}

async function sendSlack(input: NotifyInput): Promise<void> {
  const url = process.env['SLACK_WEBHOOK_URL']
  if (!url) throw new Error('SLACK_WEBHOOK_URL not set')
  const icon = input.severity === 'critical' ? ':rotating_light:' :
               input.severity === 'high'     ? ':warning:' : ':information_source:'
  const out = await fetchWithRetry('notify:slack', url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `${icon} *${input.title}*\n${input.body}${input.link ? `\n<${input.link}|Open>` : ''}`,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!out.ok) throw new Error(`Slack ${out.status}: ${out.statusText}`)
}

async function sendDiscord(input: NotifyInput): Promise<void> {
  const url = process.env['DISCORD_WEBHOOK_URL']
  if (!url) throw new Error('DISCORD_WEBHOOK_URL not set')
  const color = input.severity === 'critical' ? 15158332 :  // red
                input.severity === 'high'     ? 16753920 :  // orange
                                                3447003     // blue
  const out = await fetchWithRetry('notify:discord', url, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: input.title.slice(0, 256),
        description: input.body.slice(0, 4000),
        color,
        ...(input.link ? { url: input.link } : {}),
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!out.ok) throw new Error(`Discord ${out.status}: ${out.statusText}`)
}

// ─── Public dispatcher ───────────────────────────────────────────────────────

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'notifications', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/**
 * Build the context shouldNotifyOperator needs. Returns conservative
 * defaults on any DB miss so we never hard-fail the notification path.
 */
async function loadRestraintContext(workspaceId: string): Promise<{
  loadScore: number; loadMode: LoadMode
  recentNotifications: number; msSinceLastAck: number
}> {
  const windowMs = 30 * 60_000
  const since    = Date.now() - windowMs

  // Pull a fresh load snapshot (cheap — same query the dashboard uses).
  // Fail open: if anything throws, treat as normal load.
  let loadScore = 0.5
  let loadMode: LoadMode = 'normal'
  try {
    const { snapshotOperatorLoad } = await import('./operator-cognitive-load.js')
    const verdict = await snapshotOperatorLoad(workspaceId, { windowMs }).catch(() => null)
    if (verdict) { loadScore = verdict.loadScore; loadMode = verdict.mode as LoadMode }
  } catch { /* tolerated */ }

  // Recent notifications dispatched in the window.
  const recent = await db.select({ n: sql<number>`count(*)::int` }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'notification.dispatched'),
      gte(events.createdAt, since),
    ))
    .then(r => Number(r[0]?.n ?? 0)).catch(() => 0)

  // Last operator-acked notification (UI fires `notification.acked`).
  // If never acked, treat the start of the window as the last ack so the
  // fatigue rule needs both volume + a full window of silence.
  const lastAck = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'notification.acked'),
    ))
    .orderBy(desc(events.createdAt)).limit(1)
    .then(r => r[0]?.createdAt ?? null).catch(() => null)

  const msSinceLastAck = lastAck === null
    ? windowMs
    : Math.max(0, Date.now() - Number(lastAck))

  return { loadScore, loadMode, recentNotifications: recent, msSinceLastAck }
}

export async function notify(input: NotifyInput, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const sig = input.signature ?? input.title
  if (checkRateLimit(input.workspaceId, input.type, sig)) {
    return { sent: [], skipped: [], failed: [], rateLimited: true }
  }

  // Strategic-restraint gate (#42). Critical alerts pass; everything else
  // checks operator load, recent volume, and dedupe state first.
  if (!opts.bypassRestraint) {
    const ctx = await loadRestraintContext(input.workspaceId)
    const decision = shouldNotifyOperator(input.severity, {
      loadScore: ctx.loadScore,
      loadMode:  ctx.loadMode,
      recentNotifications: ctx.recentNotifications,
      msSinceLastAck:      ctx.msSinceLastAck,
      duplicateSignature:  false,            // already covered by rate-limit map above
    })
    if (!decision.allow) {
      await emit(input.workspaceId, 'notification.suppressed', {
        type: input.type, severity: input.severity,
        signature: sig, reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
        loadMode: ctx.loadMode, loadScore: ctx.loadScore,
      })
      return { sent: [], skipped: [], failed: [], rateLimited: false, suppressed: true, suppressedReason: decision.reason }
    }
  }

  type Driver = { name: string; fn: () => Promise<void>; gateSeverity: NotifySeverity }
  const drivers: Driver[] = [
    { name: 'webhook',  fn: () => sendWebhook(input),  gateSeverity: 'normal'   },
    { name: 'pushover', fn: () => sendPushover(input), gateSeverity: 'high'     },
    { name: 'slack',    fn: () => sendSlack(input),    gateSeverity: 'high'     },
    { name: 'discord',  fn: () => sendDiscord(input),  gateSeverity: 'high'     },
  ]

  const order = ['normal', 'high', 'critical'] as const
  const minIdx = order.indexOf(input.severity)

  const sent: string[] = []
  const skipped: string[] = []
  const failed: Array<{ driver: string; error: string }> = []

  for (const d of drivers) {
    if (order.indexOf(d.gateSeverity) > minIdx) continue   // severity too low for this driver
    try {
      await d.fn()
      sent.push(d.name)
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('not set')) skipped.push(d.name)
      else failed.push({ driver: d.name, error: msg })
    }
  }

  await emit(input.workspaceId, 'notification.dispatched', {
    type: input.type, severity: input.severity, sent, skipped, failed: failed.length,
  })

  return { sent, skipped, failed, rateLimited: false }
}

/** Quick check: which drivers are configured? */
export function configuredDrivers(): string[] {
  const out: string[] = []
  if (process.env['NOTIFY_WEBHOOK_URL'])  out.push('webhook')
  if (process.env['PUSHOVER_TOKEN'] && process.env['PUSHOVER_USER']) out.push('pushover')
  if (process.env['SLACK_WEBHOOK_URL'])   out.push('slack')
  if (process.env['DISCORD_WEBHOOK_URL']) out.push('discord')
  return out
}
