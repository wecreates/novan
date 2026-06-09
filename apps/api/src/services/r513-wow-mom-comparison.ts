/**
 * R513 — Week-over-week / month-over-month comparison.
 *
 * Returns {sales, gross, uploads} for THIS period vs PRIOR period so the
 * dashboard can show "+34% vs last week" arrows.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const DAY = 24 * 60 * 60_000

export interface PeriodMetrics {
  uploads:  number
  sales:    number
  grossUsd: number
}
export interface Comparison {
  thisWeek:    PeriodMetrics
  lastWeek:    PeriodMetrics
  thisMonth:   PeriodMetrics
  lastMonth:   PeriodMetrics
  wowSalesDelta:    number  // -1..+inf
  wowGrossDelta:    number
  momSalesDelta:    number
  momGrossDelta:    number
}

async function metricsBetween(workspaceId: string, since: number, until: number): Promise<PeriodMetrics> {
  let uploads = 0, sales = 0, gross = 0
  try {
    const ur = await db.execute(sql`SELECT COUNT(*)::int AS n FROM design_upload_queue WHERE workspace_id = ${workspaceId} AND status = 'uploaded' AND uploaded_at >= ${since} AND uploaded_at < ${until}`)
    uploads = Number((ur as unknown as Array<{ n: number }>)[0]?.n ?? 0)
    const sr = await db.execute(sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(COALESCE(gross_usd, net_usd, 0)), 0)::float AS g FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${since} AND recorded_at < ${until}`)
    sales = Number((sr as unknown as Array<{ n: number }>)[0]?.n ?? 0)
    gross = Number((sr as unknown as Array<{ g: number }>)[0]?.g ?? 0)
  } catch { /* tolerated */ }
  return { uploads, sales, grossUsd: Math.round(gross * 100) / 100 }
}

function pct(now: number, prev: number): number {
  if (prev === 0) return now > 0 ? 1 : 0
  return Math.round(((now - prev) / prev) * 1000) / 1000
}

export async function periodComparison(workspaceId: string): Promise<Comparison> {
  const now = Date.now()
  const thisWeek    = await metricsBetween(workspaceId, now - 7 * DAY,   now)
  const lastWeek    = await metricsBetween(workspaceId, now - 14 * DAY,  now - 7 * DAY)
  const thisMonth   = await metricsBetween(workspaceId, now - 30 * DAY,  now)
  const lastMonth   = await metricsBetween(workspaceId, now - 60 * DAY,  now - 30 * DAY)
  return {
    thisWeek, lastWeek, thisMonth, lastMonth,
    wowSalesDelta: pct(thisWeek.sales, lastWeek.sales),
    wowGrossDelta: pct(thisWeek.grossUsd, lastWeek.grossUsd),
    momSalesDelta: pct(thisMonth.sales, lastMonth.sales),
    momGrossDelta: pct(thisMonth.grossUsd, lastMonth.grossUsd),
  }
}
