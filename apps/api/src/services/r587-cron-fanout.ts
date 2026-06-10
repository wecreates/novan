/**
 * R587 — Per-business cron fan-out for 50-business scale.
 *
 * Today: each cron tick runs once per workspace and touches all businesses
 * inside it. With 50 businesses one slow business stalls the others.
 *
 * R587: a single workspace tick lists all businesses + iterates with
 * isolated error handling + per-business autonomy gate + per-business
 * advisory lock (R504). One business failing or kill-switched does NOT
 * affect the others.
 *
 * Schedule rules per business:
 *   - Skip business if R580 isBusinessAutonomyAllowed returns false
 *   - Skip if R580 isBusinessBudgetExhausted returns true
 *   - Wrap body in R504 withCronLock keyed by (cronName, businessId)
 *   - Catch all errors per-business so siblings continue
 *
 * Callers wire in via `runForEachBusiness(workspaceId, cronName, body)`.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface BusinessIterResult {
  business_id: string
  business_name: string
  ran: boolean
  reason?: string
  durationMs?: number
  error?: string
}

export async function runForEachBusiness(
  workspaceId: string,
  cronName: string,
  body: (businessId: string, businessName: string) => Promise<void>,
): Promise<{ workspaceId: string; cronName: string; results: BusinessIterResult[] }> {
  let businesses: Array<{ id: string; name: string }> = []
  try {
    const r = await db.execute(sql`
      SELECT id, name FROM businesses
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at ASC
    `)
    businesses = r as unknown as typeof businesses
  } catch { return { workspaceId, cronName, results: [] } }

  const results: BusinessIterResult[] = []
  const { isBusinessAutonomyAllowed, isBusinessBudgetExhausted, touchBusinessHeartbeat } = await import('./r580-business-context.js')
  const { withCronLock } = await import('./r504-cron-lock.js')

  for (const biz of businesses) {
    const t0 = Date.now()
    try {
      if (!await isBusinessAutonomyAllowed(workspaceId, biz.id)) {
        results.push({ business_id: biz.id, business_name: biz.name, ran: false, reason: 'autonomy_paused' })
        continue
      }
      if (await isBusinessBudgetExhausted(workspaceId, biz.id)) {
        results.push({ business_id: biz.id, business_name: biz.name, ran: false, reason: 'budget_exhausted' })
        continue
      }
      await withCronLock(`${cronName}|${biz.id}`, async () => {
        await body(biz.id, biz.name)
      })
      await touchBusinessHeartbeat(workspaceId, biz.id)
      results.push({ business_id: biz.id, business_name: biz.name, ran: true, durationMs: Date.now() - t0 })
    } catch (e) {
      results.push({
        business_id: biz.id, business_name: biz.name, ran: false,
        durationMs: Date.now() - t0, error: (e as Error).message.slice(0, 200),
      })
    }
  }
  return { workspaceId, cronName, results }
}

/** Snapshot: how many businesses, how many active in last 24h, by stage/health. */
export async function businessRollup(workspaceId: string): Promise<{
  total: number;
  activeLast24h: number;
  byStage: Record<string, number>;
  byHealth: Record<string, number>;
}> {
  let out = { total: 0, activeLast24h: 0, byStage: {} as Record<string, number>, byHealth: {} as Record<string, number> }
  try {
    const r = await db.execute(sql`SELECT id, name, stage, health FROM businesses WHERE workspace_id = ${workspaceId}`)
    const rows = r as unknown as Array<{ id: string; name: string; stage: string; health: string }>
    out.total = rows.length
    for (const row of rows) {
      out.byStage[row.stage] = (out.byStage[row.stage] ?? 0) + 1
      out.byHealth[row.health] = (out.byHealth[row.health] ?? 0) + 1
    }
    const { getNumSetting } = await import('./r437-operator-timezone.js')
    const cutoff = Date.now() - 24 * 60 * 60_000
    for (const row of rows) {
      const last = await getNumSetting(workspaceId, `${row.id}.last_active_at`, 0)
      if (last > cutoff) out.activeLast24h++
    }
  } catch { /* tolerated */ }
  return out
}
