/**
 * R580 — Business context helpers.
 *
 * Establishes (workspace_id, business_id) as the operational scope so 50+
 * businesses can run inside ONE operator account without their state
 * leaking into each other.
 *
 * Patterns:
 *   - resolveBusinessId(ws, explicit?) → uses explicit or workspace_settings.default_business_id
 *   - listBusinesses(ws) → enumerates from `businesses` table
 *   - perBusinessBudget(ws, biz) → reads workspace_settings.${biz}.daily_ai_budget_usd
 *     (falls back to NOVAN_DAILY_AI_BUDGET_USD env, then $10 default)
 *   - isBusinessAutonomyAllowed(ws, biz) → R443 extended for per-business kill-switch
 *   - touchBusinessHeartbeat(ws, biz) → marker for "this business is active"
 *
 * Backward compatibility: business_id is OPTIONAL everywhere. If NULL,
 * behavior is the legacy workspace-scoped path. New code can opt in.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface BusinessSummary {
  id:         string
  name:       string
  stage:      string
  health:     string
  createdAt:  number
  isDefault:  boolean
}

export async function listBusinesses(workspaceId: string): Promise<BusinessSummary[]> {
  try {
    const r = await db.execute(sql`
      SELECT id, name, stage, health, created_at FROM businesses
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC
    `)
    const defaultId = await getDefaultBusinessId(workspaceId)
    return (r as unknown as Array<{ id: string; name: string; stage: string; health: string; created_at: number }>).map(x => ({
      id: x.id, name: x.name, stage: x.stage, health: x.health, createdAt: Number(x.created_at),
      isDefault: x.id === defaultId,
    }))
  } catch { return [] }
}

export async function getDefaultBusinessId(workspaceId: string): Promise<string | null> {
  try {
    const { getSetting } = await import('./r437-operator-timezone.js')
    const v = await getSetting(workspaceId, 'default_business_id', '')
    return v || null
  } catch { return null }
}

export async function setDefaultBusinessId(workspaceId: string, businessId: string): Promise<{ ok: boolean }> {
  // Verify business exists in this workspace before saving.
  try {
    const r = await db.execute(sql`SELECT 1 FROM businesses WHERE id = ${businessId} AND workspace_id = ${workspaceId} LIMIT 1`)
    const a = r as unknown as Array<unknown>
    if (!Array.isArray(a) || a.length === 0) return { ok: false }
    const { setSetting } = await import('./r437-operator-timezone.js')
    await setSetting(workspaceId, 'default_business_id', businessId)
    return { ok: true }
  } catch { return { ok: false } }
}

/** Resolve which business this op runs under. Explicit > default > null. */
export async function resolveBusinessId(workspaceId: string, explicit?: string): Promise<string | null> {
  if (explicit) {
    try {
      const r = await db.execute(sql`SELECT 1 FROM businesses WHERE id = ${explicit} AND workspace_id = ${workspaceId} LIMIT 1`)
      const a = r as unknown as Array<unknown>
      if (Array.isArray(a) && a.length > 0) return explicit
    } catch { /* fall through */ }
  }
  return getDefaultBusinessId(workspaceId)
}

// ─── Per-business budget ────────────────────────────────────────────────────

const FALLBACK_BUDGET_USD = 10

export async function perBusinessBudget(workspaceId: string, businessId: string | null): Promise<number> {
  if (!businessId) {
    // workspace-level fallback (R540 default)
    return Number(process.env['NOVAN_DAILY_AI_BUDGET_USD'] ?? FALLBACK_BUDGET_USD)
  }
  try {
    const { getNumSetting } = await import('./r437-operator-timezone.js')
    const cap = await getNumSetting(workspaceId, `${businessId}.daily_ai_budget_usd`, 0)
    if (cap > 0) return cap
  } catch { /* fall through */ }
  return Number(process.env['NOVAN_DAILY_AI_BUDGET_USD'] ?? FALLBACK_BUDGET_USD)
}

export async function setBusinessBudget(workspaceId: string, businessId: string, dailyUsd: number): Promise<{ ok: boolean }> {
  if (!businessId || !Number.isFinite(dailyUsd) || dailyUsd < 0) return { ok: false }
  try {
    const { setSetting } = await import('./r437-operator-timezone.js')
    await setSetting(workspaceId, `${businessId}.daily_ai_budget_usd`, String(dailyUsd))
    return { ok: true }
  } catch { return { ok: false } }
}

/** Per-business spend snapshot (extends R428 spendSnapshot semantics). */
export async function businessSpendToday(workspaceId: string, businessId: string): Promise<{ todayUsd: number; callCount: number; bySource: Array<{ source: string; usd: number; calls: number }> }> {
  const day = (() => { const d = new Date(); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}` })()
  try {
    const r = await db.execute(sql`
      SELECT source, cost_usd_cents, call_count FROM ai_spend
      WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND day_yyyymmdd = ${day}
    `)
    const rows = (r as unknown as Array<{ source: string; cost_usd_cents: number; call_count: number }>).map(x => ({
      source: x.source, usd: Math.round(Number(x.cost_usd_cents)) / 100, calls: Number(x.call_count),
    }))
    return {
      todayUsd:  rows.reduce((a, b) => a + b.usd, 0),
      callCount: rows.reduce((a, b) => a + b.calls, 0),
      bySource:  rows,
    }
  } catch { return { todayUsd: 0, callCount: 0, bySource: [] } }
}

export async function isBusinessBudgetExhausted(workspaceId: string, businessId: string): Promise<boolean> {
  const cap = await perBusinessBudget(workspaceId, businessId)
  if (cap <= 0) return false
  const snap = await businessSpendToday(workspaceId, businessId)
  return snap.todayUsd >= cap
}

// ─── Per-business kill switch ──────────────────────────────────────────────

export async function isBusinessAutonomyAllowed(workspaceId: string, businessId: string | null): Promise<boolean> {
  // Workspace-level switch wins (operator-wide pause)
  try {
    const { isAutonomyAllowed } = await import('./r443-autonomy-gate.js')
    if (!await isAutonomyAllowed(workspaceId)) return false
  } catch { /* tolerated */ }
  if (!businessId) return true
  // Per-business override
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM kill_switches
      WHERE workspace_id = ${workspaceId} AND business_id = ${businessId}
        AND switch_type = 'autonomous_writes' AND enabled = false
      LIMIT 1
    `)
    const a = r as unknown as Array<unknown>
    if (Array.isArray(a) && a.length > 0) return false
    return true
  } catch { return true }
}

export async function setBusinessKillSwitch(workspaceId: string, businessId: string, engaged: boolean): Promise<{ ok: boolean }> {
  try {
    if (engaged) {
      await db.execute(sql`
        INSERT INTO kill_switches (workspace_id, business_id, switch_type, enabled, updated_at)
        VALUES (${workspaceId}, ${businessId}, 'autonomous_writes', false, ${Date.now()})
        ON CONFLICT DO NOTHING
      `).catch(async () => {
        // Without a unique constraint that includes business_id we just upsert manually.
        await db.execute(sql`
          UPDATE kill_switches SET enabled = false, updated_at = ${Date.now()}
          WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND switch_type = 'autonomous_writes'
        `).catch(() => {/* tolerated */})
      })
    } else {
      await db.execute(sql`
        DELETE FROM kill_switches
        WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND switch_type = 'autonomous_writes' AND enabled = false
      `).catch(() => {/* tolerated */})
    }
    return { ok: true }
  } catch { return { ok: false } }
}

// ─── Heartbeat (for "is this business active?") ───────────────────────────

export async function touchBusinessHeartbeat(workspaceId: string, businessId: string): Promise<void> {
  try {
    const { setSetting } = await import('./r437-operator-timezone.js')
    await setSetting(workspaceId, `${businessId}.last_active_at`, String(Date.now()))
  } catch { /* tolerated */ }
}

export async function businessHeartbeatAges(workspaceId: string): Promise<Array<{ businessId: string; name: string; lastActiveAt: number | null; ageHours: number | null }>> {
  const list = await listBusinesses(workspaceId)
  const { getNumSetting } = await import('./r437-operator-timezone.js')
  const out: Array<{ businessId: string; name: string; lastActiveAt: number | null; ageHours: number | null }> = []
  for (const b of list) {
    const last = await getNumSetting(workspaceId, `${b.id}.last_active_at`, 0)
    out.push({
      businessId:   b.id,
      name:         b.name,
      lastActiveAt: last > 0 ? last : null,
      ageHours:     last > 0 ? Math.round((Date.now() - last) / 3600_000 * 10) / 10 : null,
    })
  }
  return out
}
