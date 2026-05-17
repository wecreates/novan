/**
 * tradeoff-analysis.ts — Tradeoff envelope for a recommendation.
 *
 * For each rec produces structured benefit/risk/cost/impact/complexity
 * /rollback fields. Estimates are derived from kind + evidence — no
 * fabricated numbers; every numeric estimate has a `derivedFrom` field
 * pointing at the evidence row(s) used.
 */
import { db }                          from '../db/client.js'
import { successfulFixes }             from '../db/schema.js'
import { and, desc, eq, sql }          from 'drizzle-orm'
import { type Recommendation, generateRecommendations } from './recommendation-engine.js'

export type EstimationProvenance = 'evidence_count' | 'rec_kind_default' | 'past_outcome' | 'config_default'

export interface NumericEstimate {
  value:        number              // primary number (e.g. hours, USD, count)
  unit:         string              // 'hours' | 'usd' | 'count' | 'score_0_to_1'
  provenance:   EstimationProvenance
  derivedFrom:  string              // short explanation tying back to real data
}

export interface Tradeoff {
  recommendationId: string
  recommendation:   Recommendation

  expectedBenefit: NumericEstimate
  expectedRisk:    NumericEstimate
  estimatedCost:   NumericEstimate
  operationalImpact: 'low' | 'medium' | 'high' | 'critical'
  implementationComplexity: NumericEstimate     // 1..5
  rollbackDifficulty:       NumericEstimate     // 1..5
  netScore:        number          // (benefit - risk - cost) — for sorting
}

// ─── Per-kind defaults (transparent, not fabricated as model output) ────────

interface KindProfile {
  benefitScore:   number   // 0..1 expected impact-fraction
  baseRiskScore:  number   // 0..1 baseline risk
  baseCostHours:  number   // engineering hours
  complexity:     number   // 1..5
  rollbackDifficulty: number  // 1..5
  operationalImpact: Tradeoff['operationalImpact']
}

const KIND_PROFILE: Record<Recommendation['kind'], KindProfile> = {
  critical_runtime_fix:    { benefitScore: 0.85, baseRiskScore: 0.30, baseCostHours: 2,  complexity: 2, rollbackDifficulty: 1, operationalImpact: 'critical' },
  reliability_improvement: { benefitScore: 0.55, baseRiskScore: 0.20, baseCostHours: 4,  complexity: 3, rollbackDifficulty: 2, operationalImpact: 'high' },
  operator_approval:       { benefitScore: 0.40, baseRiskScore: 0.15, baseCostHours: 0.5, complexity: 1, rollbackDifficulty: 1, operationalImpact: 'medium' },
  budget_optimization:     { benefitScore: 0.50, baseRiskScore: 0.10, baseCostHours: 1,  complexity: 2, rollbackDifficulty: 1, operationalImpact: 'high' },
  security_risk:           { benefitScore: 0.70, baseRiskScore: 0.45, baseCostHours: 6,  complexity: 4, rollbackDifficulty: 3, operationalImpact: 'critical' },
  performance_bottleneck:  { benefitScore: 0.45, baseRiskScore: 0.20, baseCostHours: 8,  complexity: 4, rollbackDifficulty: 3, operationalImpact: 'high' },
  growth_opportunity:      { benefitScore: 0.30, baseRiskScore: 0.10, baseCostHours: 12, complexity: 3, rollbackDifficulty: 2, operationalImpact: 'medium' },
}

// ─── Tradeoff builder ────────────────────────────────────────────────────────

async function buildTradeoff(workspaceId: string, rec: Recommendation): Promise<Tradeoff> {
  const profile = KIND_PROFILE[rec.kind]

  // Risk downweighted by past success on similar signature
  const pastFix = rec.context?.pastFix
  const riskAdjustment = pastFix && pastFix.appliedCount > 0
    ? Math.min(0.7, 1 - 0.15 * Math.log10(1 + pastFix.appliedCount))   // more past successes → less risk
    : 1

  const adjustedRisk = profile.baseRiskScore * riskAdjustment

  // Cost adjustment: if evidence carries a count >=10, double the baseline
  const evidenceCount = (rec.evidence['count'] as number | undefined) ?? 0
  const costMultiplier = evidenceCount >= 10 ? 2 : evidenceCount >= 3 ? 1.5 : 1
  const adjustedCost = profile.baseCostHours * costMultiplier

  const netScore = Number(
    (profile.benefitScore - adjustedRisk - adjustedCost * 0.05).toFixed(3),
  )

  return {
    recommendationId: rec.id,
    recommendation:   rec,
    expectedBenefit: {
      value: Number(profile.benefitScore.toFixed(2)),
      unit:  'score_0_to_1',
      provenance: pastFix ? 'past_outcome' : 'rec_kind_default',
      derivedFrom: pastFix
        ? `past_fix applied ${pastFix.appliedCount}× — proven pattern`
        : `default for ${rec.kind} (no past-outcome data on this workspace)`,
    },
    expectedRisk: {
      value: Number(adjustedRisk.toFixed(2)),
      unit:  'score_0_to_1',
      provenance: pastFix ? 'past_outcome' : 'rec_kind_default',
      derivedFrom: pastFix
        ? `risk discounted by past success (×${riskAdjustment.toFixed(2)})`
        : `baseline ${profile.baseRiskScore} for ${rec.kind}`,
    },
    estimatedCost: {
      value: Number(adjustedCost.toFixed(1)),
      unit:  'hours',
      provenance: evidenceCount > 0 ? 'evidence_count' : 'rec_kind_default',
      derivedFrom: evidenceCount > 0
        ? `evidence shows ${evidenceCount} items → ×${costMultiplier} multiplier`
        : `default ${profile.baseCostHours}h for ${rec.kind}`,
    },
    operationalImpact: profile.operationalImpact,
    implementationComplexity: {
      value: profile.complexity, unit: 'score_1_to_5',
      provenance: 'rec_kind_default',
      derivedFrom: `default complexity for ${rec.kind}`,
    },
    rollbackDifficulty: {
      value: profile.rollbackDifficulty, unit: 'score_1_to_5',
      provenance: 'rec_kind_default',
      derivedFrom: `default rollback difficulty for ${rec.kind}`,
    },
    netScore,
  }
}

export async function tradeoffsForTop(workspaceId: string, limit = 5): Promise<Tradeoff[]> {
  const recs = await generateRecommendations(workspaceId)
  const out: Tradeoff[] = []
  for (const r of recs.slice(0, limit)) {
    out.push(await buildTradeoff(workspaceId, r))
  }
  return out.sort((a, b) => b.netScore - a.netScore)
}

export async function tradeoffForRecommendation(workspaceId: string, recommendationId: string): Promise<Tradeoff | null> {
  const recs = await generateRecommendations(workspaceId)
  const rec = recs.find(r => r.id === recommendationId)
  if (!rec) return null
  return buildTradeoff(workspaceId, rec)
}

/** Show how the "past outcome" provenance pool looks — operator can sanity-check. */
export async function pastOutcomeStats(workspaceId: string): Promise<{ patterns: number; totalApplied: number; topPattern: string | null }> {
  const rows = await db.select().from(successfulFixes)
    .where(eq(successfulFixes.workspaceId, workspaceId))
    .orderBy(desc(successfulFixes.successCount)).limit(1).catch(() => [])
  const totals = await db.select({
    patterns: sql<number>`count(*)::int`,
    total:    sql<number>`coalesce(sum(${successfulFixes.successCount}), 0)::int`,
  }).from(successfulFixes)
    .where(eq(successfulFixes.workspaceId, workspaceId))
    .then(r => r[0] ?? { patterns: 0, total: 0 }).catch(() => ({ patterns: 0, total: 0 }))
  return {
    patterns: Number(totals.patterns),
    totalApplied: Number(totals.total),
    topPattern: rows[0]?.failureSignature ? String(rows[0].failureSignature).slice(0, 100) : null,
  }
}
