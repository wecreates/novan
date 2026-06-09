/**
 * R413 — Weekly recap push (Sunday 14:00 UTC).
 *
 * Composes a 7-day rollup (uploads, sales, MRR, top design, niche winner,
 * new platforms activated) and broadcasts to every subscribed device per
 * workspace. Operator gets a Sunday morning summary of the past week's
 * autonomous activity.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS weekly_recap_pushes (
      workspace_id  TEXT NOT NULL,
      iso_week      TEXT NOT NULL,
      pushed_at     BIGINT NOT NULL,
      body          TEXT,
      PRIMARY KEY (workspace_id, iso_week)
    )
  `).catch(() => {})
}

function isoWeek(): string {
  const d = new Date()
  // ISO-style YYYY-Wnn
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((+d - +yearStart) / 86400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

export interface WeeklyRecapResult {
  workspaces: number
  pushed:     number
  skipped:    Array<{ workspaceId: string; reason: string }>
}

export async function pushWeeklyRecap(): Promise<WeeklyRecapResult> {
  await ensureTable()
  const result: WeeklyRecapResult = { workspaces: 0, pushed: 0, skipped: [] }
  const week = isoWeek()
  const weekCutoff = Date.now() - 7 * 24 * 60 * 60_000

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { workspaceIds = ['default'] }
  if (workspaceIds.length === 0) workspaceIds = ['default']

  const { broadcastPush } = await import('./web-push.js')

  for (const ws of workspaceIds) {
    result.workspaces++
    const exists = await db.execute(sql`
      SELECT 1 FROM weekly_recap_pushes WHERE workspace_id = ${ws} AND iso_week = ${week} LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(exists) && exists.length > 0) {
      result.skipped.push({ workspaceId: ws, reason: 'already pushed this week' })
      continue
    }

    try {
      const u = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM design_upload_queue
        WHERE workspace_id = ${ws} AND status = 'uploaded' AND uploaded_at >= ${weekCutoff}
      `)
      const uploads = Number((u as Array<{ n: number }>)[0]?.n ?? 0)
      const s = await db.execute(sql`
        SELECT COUNT(*)::int AS n, COALESCE(SUM(net_usd),0)::float AS usd
        FROM business_revenue WHERE workspace_id = ${ws} AND recorded_at >= ${weekCutoff}
      `)
      const sales = Number((s as Array<{ n: number }>)[0]?.n ?? 0)
      const usd = Number((s as Array<{ usd: number }>)[0]?.usd ?? 0)

      let topPrompt = ''
      try {
        const { rankDesignPerformance } = await import('./r395-design-performance.js')
        const r = await rankDesignPerformance(ws, 1)
        if (r.designs.length > 0) topPrompt = r.designs[0]!.prompt.slice(0, 40)
      } catch { /* tolerated */ }

      let topNiche = ''
      try {
        const { rankNichePerformance } = await import('./r404-niche-performance.js')
        const r = await rankNichePerformance(ws)
        if (r.niches.length > 0) topNiche = r.niches[0]!.niche
      } catch { /* tolerated */ }

      const body = `Week ${week}: ${uploads} uploads, ${sales} sales ($${usd.toFixed(2)})${topPrompt ? ` · Top: ${topPrompt}` : ''}${topNiche ? ` · Niche: ${topNiche}` : ''}`.slice(0, 200)

      void broadcastPush(ws, {
        title: '📊 Novan weekly recap',
        body,
        url:   '/ops/dashboard',
        tag:   `weekly-${week}`,
      })

      await db.execute(sql`
        INSERT INTO weekly_recap_pushes (workspace_id, iso_week, pushed_at, body)
        VALUES (${ws}, ${week}, ${Date.now()}, ${body})
        ON CONFLICT (workspace_id, iso_week) DO NOTHING
      `).catch(() => {/* best effort */})
      result.pushed++
    } catch (e) {
      result.skipped.push({ workspaceId: ws, reason: (e as Error).message.slice(0, 100) })
    }
  }
  return result
}
