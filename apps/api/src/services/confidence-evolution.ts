/**
 * confidence-evolution.ts — Re-weight confidence based on real outcomes.
 *
 * Inputs (real signals):
 *   - recommendation kind hit-rate (from reasoning_chains with outcomeKnown)
 *   - successful_fixes count for similar signatures
 *   - operator approval rates (patch_approvals)
 *   - rollback rates (events)
 *
 * Outputs:
 *   - per-kind hit-rate (raw)
 *   - per-kind confidence adjustment suggestion (+/- delta)
 *   - calibration delta vs the engine's heuristic baseline
 *
 * Honest: this REPORTS adjustments but does NOT auto-apply weight
 * changes. Recommendation engine's PRIORITY_WEIGHTS stay static unless
 * operator updates them. Auto-rewriting weights is part of the dynamic
 * priority rebalancing path I explicitly refused (autonomy boundary).
 */
import { db }                          from '../db/client.js'
import { reasoningChains, patchApprovals, events, successfulFixes } from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'

export interface ConfidenceEvolutionReport {
  workspaceId:        string
  perKind: Array<{
    kind:             string
    totalChains:      number
    withOutcome:      number
    hitRate:          number | null
    avgConfidence:    number | null
    suggestedDelta:   number | null    // signed adjustment vs avg confidence
    rationale:        string
  }>
  approvalRate:       number | null
  rollbackRate:       number | null
  fixHistorySize:     number
  recommendation:     string
}

export async function evolveConfidence(workspaceId: string): Promise<ConfidenceEvolutionReport> {
  // Per-kind chain stats
  const chainStats = await db.select({
    kind:    reasoningChains.kind,
    total:   sql<number>`count(*)::int`,
    withOut: sql<number>`count(*) filter (where ${reasoningChains.outcomeKnown} = true)::int`,
    matched: sql<number>`count(*) filter (where ${reasoningChains.outcomeMatched} = true)::int`,
    avgConf: sql<number>`coalesce(avg(${reasoningChains.confidence}), 0)::float`,
  }).from(reasoningChains)
    .where(eq(reasoningChains.workspaceId, workspaceId))
    .groupBy(reasoningChains.kind).catch(() => [])

  const perKind = chainStats.map(r => {
    const total = Number(r.total ?? 0)
    const withOutcome = Number(r.withOut ?? 0)
    const matched = Number(r.matched ?? 0)
    const hitRate = withOutcome > 0 ? Number((matched / withOutcome).toFixed(3)) : null
    const avgConfidence = total > 0 ? Number(Number(r.avgConf).toFixed(3)) : null
    let suggestedDelta: number | null = null
    let rationale = ''
    if (hitRate !== null && avgConfidence !== null) {
      // delta = hitRate - avgConfidence (negative = overconfident, positive = underconfident)
      suggestedDelta = Number((hitRate - avgConfidence).toFixed(3))
      if (Math.abs(suggestedDelta) < 0.05) rationale = 'well-calibrated'
      else if (suggestedDelta < 0)         rationale = `overconfident by ${Math.abs(suggestedDelta * 100).toFixed(1)}% — consider lowering kind weight`
      else                                  rationale = `underconfident by ${(suggestedDelta * 100).toFixed(1)}% — consider raising kind weight`
    } else if (total > 0 && withOutcome === 0) {
      rationale = 'no outcomes yet — calibration unknown'
    } else {
      rationale = 'insufficient data'
    }
    return { kind: r.kind, totalChains: total, withOutcome, hitRate, avgConfidence, suggestedDelta, rationale }
  })

  // Operator approval rate
  const apprStats = await db.select({
    approved: sql<number>`count(*) filter (where ${patchApprovals.status} = 'approved')::int`,
    rejected: sql<number>`count(*) filter (where ${patchApprovals.status} = 'rejected')::int`,
  }).from(patchApprovals)
    .where(eq(patchApprovals.workspaceId, workspaceId))
    .then(r => r[0]).catch(() => null)
  const decided = Number(apprStats?.approved ?? 0) + Number(apprStats?.rejected ?? 0)
  const approvalRate = decided > 0 ? Number((Number(apprStats!.approved) / decided).toFixed(3)) : null

  // Rollback rate vs patches applied
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000
  const patchStats = await db.select({
    applied:    sql<number>`count(*) filter (where ${events.type} in ('patch.applied','patch.auto_applied'))::int`,
    rolledBack: sql<number>`count(*) filter (where ${events.type} = 'patch.rolled_back')::int`,
  }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, weekAgo)))
    .then(r => r[0]).catch(() => null)
  const applied = Number(patchStats?.applied ?? 0)
  const rolledBack = Number(patchStats?.rolledBack ?? 0)
  const rollbackRate = applied > 0 ? Number((rolledBack / applied).toFixed(3)) : null

  // Fix-history size (signal of confidence ground-truth pool)
  const fixHistorySize = await db.select({ c: sql<number>`coalesce(sum(${successfulFixes.successCount}),0)::int` })
    .from(successfulFixes).where(eq(successfulFixes.workspaceId, workspaceId))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)

  // Overall recommendation
  const totalKnownOutcomes = perKind.reduce((s, k) => s + k.withOutcome, 0)
  let recommendation: string
  if (totalKnownOutcomes < 10) {
    recommendation = `Insufficient outcome data (${totalKnownOutcomes} known). Confidence weights kept at defaults until more reasoning chains have known outcomes.`
  } else {
    const miscalibrated = perKind.filter(k => k.suggestedDelta !== null && Math.abs(k.suggestedDelta) >= 0.1)
    if (miscalibrated.length === 0) {
      recommendation = 'Confidence is well-calibrated across all kinds — no weight changes suggested.'
    } else {
      recommendation = `${miscalibrated.length} kind(s) miscalibrated by ≥10%. Suggested operator action: review per-kind deltas above. (Auto-rewrite of weights NOT performed — autonomy boundary.)`
    }
  }

  return { workspaceId, perKind, approvalRate, rollbackRate, fixHistorySize, recommendation }
}
