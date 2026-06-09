/**
 * R414 — MRR run-rate projection.
 *
 * Computes 14-day rolling sales rate (USD/day average) and projects how
 * many days until each remaining goal-ladder tier threshold is hit.
 * Operator sees forward momentum: "you'll hit $1k MRR in 47 days at
 * current pace."
 *
 * Also computes acceleration: 7-day rate vs 14-day rate. Positive = pace
 * improving, negative = slowing down.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { LADDER, classifyTier } from './r350-goal-ladder.js'

export interface MrrProjection {
  currentMrr30d:        number
  rate7dUsdPerDay:      number
  rate14dUsdPerDay:     number
  rateChangePct:        number    // > 0 = accelerating
  currentTier:          string
  projections: Array<{
    tier:               string
    threshold:          number
    gapUsd:             number
    daysToReach:        number | null   // null if rate ≤ 0
    reachableDate:      string | null
  }>
}

export async function projectMrr(workspaceId: string): Promise<MrrProjection> {
  const dayMs = 24 * 60 * 60_000
  const now = Date.now()
  const cutoff7 = now - 7 * dayMs
  const cutoff14 = now - 14 * dayMs
  const cutoff30 = now - 30 * dayMs

  let mrr30 = 0, rev7 = 0, rev14 = 0
  try {
    const r30 = await db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS usd FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${cutoff30}`)
    mrr30 = Number((r30 as unknown as Array<{ usd: number }>)[0]?.usd ?? 0)
    const r7 = await db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS usd FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${cutoff7}`)
    rev7 = Number((r7 as unknown as Array<{ usd: number }>)[0]?.usd ?? 0)
    const r14 = await db.execute(sql`SELECT COALESCE(SUM(net_usd),0)::float AS usd FROM business_revenue WHERE workspace_id = ${workspaceId} AND recorded_at >= ${cutoff14}`)
    rev14 = Number((r14 as unknown as Array<{ usd: number }>)[0]?.usd ?? 0)
  } catch { /* tolerated */ }

  const rate7 = rev7 / 7
  const rate14 = rev14 / 14
  const change = rate14 > 0 ? ((rate7 - rate14) / rate14) * 100 : 0
  const tier = classifyTier(mrr30).tier
  const tierIdx = LADDER.findIndex(t => t.tier === tier)
  const future = LADDER.slice(tierIdx + 1)

  const projections = future.map(t => {
    const gap = Math.max(0, t.mrrThresholdUsd - mrr30)
    // Use the better of the two rates so projection is optimistic
    const effectiveRate = Math.max(rate7, rate14)
    if (effectiveRate <= 0 || gap <= 0) {
      return {
        tier: t.tier,
        threshold: t.mrrThresholdUsd,
        gapUsd: Math.round(gap * 100) / 100,
        daysToReach: null,
        reachableDate: null,
      }
    }
    const days = Math.ceil(gap / effectiveRate)
    const reachable = new Date(now + days * dayMs).toISOString().slice(0, 10)
    return {
      tier: t.tier,
      threshold: t.mrrThresholdUsd,
      gapUsd: Math.round(gap * 100) / 100,
      daysToReach: days,
      reachableDate: reachable,
    }
  })

  return {
    currentMrr30d:    Math.round(mrr30 * 100) / 100,
    rate7dUsdPerDay:  Math.round(rate7 * 100) / 100,
    rate14dUsdPerDay: Math.round(rate14 * 100) / 100,
    rateChangePct:    Math.round(change * 10) / 10,
    currentTier:      tier,
    projections,
  }
}
