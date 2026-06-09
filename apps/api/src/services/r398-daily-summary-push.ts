/**
 * R398 — Daily morning summary push.
 *
 * Once per UTC day at 14:00 UTC (~08:00 ET), composes a short summary of
 * the prior 24h (uploads, sales, MRR-30d, top winner, current next-action)
 * and broadcasts to every subscribed device per workspace. Operator gets
 * a morning briefing without opening the dashboard.
 *
 * Persisted in daily_summary_pushes table for idempotency (1/day).
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS daily_summary_pushes (
      workspace_id  TEXT NOT NULL,
      day_yyyymmdd  TEXT NOT NULL,
      pushed_at     BIGINT NOT NULL,
      body          TEXT,
      PRIMARY KEY (workspace_id, day_yyyymmdd)
    )
  `).catch(() => {})
}

function todayYYYYMMDD(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export interface DailySummaryResult {
  workspaces: number
  pushed:     number
  skipped:    Array<{ workspaceId: string; reason: string }>
}

export async function pushDailySummary(): Promise<DailySummaryResult> {
  await ensureTable()
  const result: DailySummaryResult = { workspaces: 0, pushed: 0, skipped: [] }
  const yyyymmdd = todayYYYYMMDD()

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { workspaceIds = ['default'] }
  if (workspaceIds.length === 0) workspaceIds = ['default']

  const { broadcastPush } = await import('./web-push.js')

  for (const ws of workspaceIds) {
    result.workspaces++
    // Idempotency
    const exists = await db.execute(sql`
      SELECT 1 FROM daily_summary_pushes WHERE workspace_id = ${ws} AND day_yyyymmdd = ${yyyymmdd} LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(exists) && exists.length > 0) {
      result.skipped.push({ workspaceId: ws, reason: 'already pushed today' })
      continue
    }

    try {
      const dayCutoff = Date.now() - 24 * 60 * 60_000
      const monthCutoff = Date.now() - 30 * 24 * 60 * 60_000
      const ur = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM design_upload_queue
        WHERE workspace_id = ${ws} AND status = 'uploaded' AND uploaded_at >= ${dayCutoff}
      `)
      const uploads24h = Number((ur as Array<{ n: number }>)[0]?.n ?? 0)
      const sr = await db.execute(sql`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(net_usd),0)::float AS usd
        FROM business_revenue WHERE workspace_id = ${ws} AND recorded_at >= ${dayCutoff}
      `)
      const sales24h = Number((sr as Array<{ n: number }>)[0]?.n ?? 0)
      const usd24h = Number((sr as Array<{ usd: number }>)[0]?.usd ?? 0)
      const mr = await db.execute(sql`
        SELECT COALESCE(SUM(net_usd),0)::float AS usd FROM business_revenue
        WHERE workspace_id = ${ws} AND recorded_at >= ${monthCutoff}
      `)
      const mrr30 = Number((mr as Array<{ usd: number }>)[0]?.usd ?? 0)

      let topTitle = ''
      try {
        const { rankDesignPerformance } = await import('./r395-design-performance.js')
        const r = await rankDesignPerformance(ws, 1)
        if (r.designs.length > 0) topTitle = r.designs[0]!.prompt.slice(0, 40)
      } catch { /* tolerated */ }

      let nextAction = ''
      try {
        const { nextActions } = await import('./r385-next-action-recommender.js')
        const r = await nextActions(ws)
        if (r.actions.length > 0) nextAction = r.actions[0]!.title
      } catch { /* tolerated */ }

      const body = `${uploads24h} uploads · ${sales24h} sales ($${usd24h.toFixed(2)}) · MRR $${mrr30.toFixed(2)}${topTitle ? ` · Top: ${topTitle}` : ''}${nextAction ? ` · Do: ${nextAction}` : ''}`.slice(0, 200)

      void broadcastPush(ws, {
        title: '☀ Novan morning summary',
        body,
        url:   '/ops/dashboard',
        tag:   `daily-summary-${yyyymmdd}`,
      })

      await db.execute(sql`
        INSERT INTO daily_summary_pushes (workspace_id, day_yyyymmdd, pushed_at, body)
        VALUES (${ws}, ${yyyymmdd}, ${Date.now()}, ${body})
        ON CONFLICT (workspace_id, day_yyyymmdd) DO NOTHING
      `).catch(() => {/* best effort */})
      result.pushed++
    } catch (e) {
      result.skipped.push({ workspaceId: ws, reason: (e as Error).message.slice(0, 100) })
    }
  }
  return result
}
