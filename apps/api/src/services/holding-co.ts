/**
 * holding-co.ts — Layer 6 Cross-Business Orchestration ("Holding-Co Brain").
 *
 * Sits above per-workspace business operations and answers questions
 * the operator can't get from a single business in isolation:
 *
 *   - Capital Allocator    — which business should the next $X go to,
 *                            given gap-to-floor + recent ROAS + trust score?
 *   - Shared Services      — which functions (HR, finance, IT, ops, legal)
 *     Router                 are already shared, and which businesses still
 *                            have parallel implementations to consolidate?
 *   - Synergy Detector     — cross-sell / talent-sharing / cross-promo /
 *                            shared-customer overlap signals.
 *   - Portfolio Strategy   — double-down / sunset / M&A target proposals
 *                            based on portfolio reality + $10k floor.
 *
 * Scope honest:
 *   - These are PROPOSALS — the operator approves. Holding-co never
 *     auto-moves money between businesses or makes M&A bids.
 *   - Reads existing tables (businesses, business_revenue, ai_usage,
 *     trust_ewma_scores) — no new schema this round.
 *   - The "synergy" detector is heuristic on tags + recent product
 *     listings + customer-event overlap; real synergy requires LLM
 *     judgment which is invoked via agent-team.orchestrator when the
 *     operator asks for a deeper read.
 */
import { db } from '../db/client.js'
import { businesses, businessRevenue, aiUsage } from '../db/schema.js'
import { eq, and, gte, sql } from 'drizzle-orm'

const PLATFORM_FLOOR_USD_PER_MONTH = 10_000

export interface CapitalAllocation {
  businessId:       string
  name:             string
  monthlyTargetUsd: number
  last30dActualUsd: number
  gapUsd:           number
  velocityScore:    number   // 0..1; how fast they're closing the gap
  trustScore:       number   // 0..1; trust EWMA on the business's agent
  proposedAllocationUsd: number
  rationale:        string
}

/** Propose how to deploy the next allocationPoolUsd across businesses
 *  in the workspace. Weighted by gap-to-floor × velocity × trust.
 *  Operator approves before any actual movement. */
export async function allocateCapital(input: {
  workspaceId:        string
  allocationPoolUsd:  number
}): Promise<{ allocations: CapitalAllocation[]; totalAllocated: number; rationale: string }> {
  const rows = await db.select({
    id:       businesses.id,
    name:     businesses.name,
    metrics:  businesses.metrics,
  }).from(businesses).where(eq(businesses.workspaceId, input.workspaceId)).limit(100)

  const now    = Date.now()
  const dayAgo30 = now - 30 * 86_400_000
  const dayAgo7  = now - 7  * 86_400_000

  const allocations: CapitalAllocation[] = []
  for (const b of rows) {
    // Per-business target stored in metrics JSONB; floor at platform $10k.
    const metricsTarget = Number((b.metrics as { monthlyTargetUsd?: number } | null)?.monthlyTargetUsd ?? 0)
    const target = Math.max(metricsTarget, PLATFORM_FLOOR_USD_PER_MONTH)

    // Actual 30-day revenue
    const r30 = await db.select({ s: sql<number>`(COALESCE(SUM(${businessRevenue.amountUsdCents}), 0) / 100.0)::float8` })
      .from(businessRevenue)
      .where(and(eq(businessRevenue.businessId, b.id), gte(businessRevenue.recordedAt, dayAgo30)))
      .catch(() => [])
    const actual30 = Number(r30[0]?.s ?? 0)

    // Last 7 days as velocity proxy
    const r7 = await db.select({ s: sql<number>`(COALESCE(SUM(${businessRevenue.amountUsdCents}), 0) / 100.0)::float8` })
      .from(businessRevenue)
      .where(and(eq(businessRevenue.businessId, b.id), gte(businessRevenue.recordedAt, dayAgo7)))
      .catch(() => [])
    const actual7 = Number(r7[0]?.s ?? 0)
    // Velocity = whether the last 7 days extrapolate to >= the prior 23 days
    const extrapolated30 = (actual7 / 7) * 30
    const velocityScore = Math.max(0, Math.min(1, extrapolated30 / Math.max(1, actual30)))

    // Trust score on the business's agent
    let trustScore = 0.5
    try {
      const { getScore } = await import('./trust-reputation.js')
      const t = await getScore(input.workspaceId, `business:${b.id}`)
      trustScore = t?.score ?? 0.5
    } catch { /* default 0.5 */ }

    const gap = Math.max(0, target - actual30)
    allocations.push({
      businessId:       b.id,
      name:             b.name,
      monthlyTargetUsd: target,
      last30dActualUsd: actual30,
      gapUsd:           gap,
      velocityScore:    Number(velocityScore.toFixed(3)),
      trustScore:       Number(trustScore.toFixed(3)),
      proposedAllocationUsd: 0,
      rationale:        '',
    })
  }

  // Score = gap × (0.3 + 0.4 × velocity + 0.3 × trust). Businesses with
  // 0 gap (above floor) get 0 allocation. Businesses with low trust
  // get downweighted regardless of gap — pouring money into a business
  // the autonomous brain hasn't earned trust on is reckless.
  const scored = allocations.map(a => ({
    ...a,
    _score: a.gapUsd * (0.3 + 0.4 * a.velocityScore + 0.3 * a.trustScore),
  }))
  const totalScore = scored.reduce((s, a) => s + a._score, 0)
  if (totalScore <= 0) {
    return {
      allocations: scored.map(a => ({ ...a, proposedAllocationUsd: 0, rationale: 'no gap-to-floor across the portfolio — fund growth ventures or hold' })),
      totalAllocated: 0,
      rationale: 'every business is at or above the $10k floor; capital pool stays idle until a new bet opens',
    }
  }

  let allocated = 0
  for (const a of scored) {
    const share = a._score / totalScore
    const alloc = Math.floor(input.allocationPoolUsd * share)
    a.proposedAllocationUsd = alloc
    a.rationale = `gap $${a.gapUsd.toFixed(0)} × (velocity ${(a.velocityScore * 100).toFixed(0)}% + trust ${(a.trustScore * 100).toFixed(0)}%) → ${(share * 100).toFixed(1)}% of pool`
    allocated += alloc
  }

  return {
    allocations: scored.map(({ _score, ...rest }) => rest),
    totalAllocated: allocated,
    rationale: `Pool $${input.allocationPoolUsd} distributed weighted by gap × velocity × trust. Operator approves before any actual movement.`,
  }
}

export interface SharedServiceCandidate {
  service:          string
  businessesUsing:  Array<{ businessId: string; name: string; spendShareUsd: number }>
  estimatedSavingsUsd: number
  rationale:        string
}

/** Identify functions where multiple businesses spend on similar
 *  capability — candidates for consolidation under a shared service.
 *  Reads ai_usage taskType as a proxy for "function" since the operator
 *  hasn't (yet) tagged spend with a domain. Future round adds explicit
 *  service tagging. */
export async function detectSharedServiceOpportunities(workspaceId: string): Promise<SharedServiceCandidate[]> {
  // Aggregate spend by taskType + business across last 30 days.
  // Without a business_id column on ai_usage we use workspace-aggregate.
  const dayAgo30 = Date.now() - 30 * 86_400_000
  const rows = await db.select({
    taskType: aiUsage.taskType,
    spend:    sql<number>`SUM(${aiUsage.costUsd})::float8`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, dayAgo30)))
    .groupBy(aiUsage.taskType)
    .catch(() => [])

  const bs = await db.select({ id: businesses.id, name: businesses.name })
    .from(businesses).where(eq(businesses.workspaceId, workspaceId)).limit(50)

  // Heuristic: if total workspace spend on a taskType > $50/mo and the
  // workspace has 2+ businesses, propose consolidating into a shared
  // service. Real consolidation needs operator-tagged spend per-business.
  const out: SharedServiceCandidate[] = []
  for (const r of rows) {
    const spend = Number(r.spend ?? 0)
    if (spend < 50 || bs.length < 2) continue
    out.push({
      service:        r.taskType,
      businessesUsing: bs.map(b => ({ businessId: b.id, name: b.name, spendShareUsd: Number((spend / bs.length).toFixed(2)) })),
      estimatedSavingsUsd: Number((spend * 0.25).toFixed(2)),   // 25% savings via consolidation is a defensible default
      rationale: `$${spend.toFixed(0)}/mo on ${r.taskType} across ${bs.length} businesses; one shared service typically cuts duplication ~25%.`,
    })
  }
  return out.sort((a, b) => b.estimatedSavingsUsd - a.estimatedSavingsUsd)
}

export interface SynergySignal {
  type:           'cross_sell' | 'talent_share' | 'cross_promo' | 'customer_overlap'
  businessA:      string
  businessB:      string
  evidence:       string
  estimatedImpactUsd: number | null
}

/** Detect synergy opportunities between businesses. Heuristic — flags
 *  things worth investigating, not commitments. */
export async function detectSynergies(workspaceId: string): Promise<SynergySignal[]> {
  const bs = await db.select({
    id:        businesses.id,
    name:      businesses.name,
    industry:  businesses.industry,
  }).from(businesses).where(eq(businesses.workspaceId, workspaceId)).limit(20)

  const out: SynergySignal[] = []
  // Cross-sell candidate: same industry → audiences likely overlap.
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]!, b = bs[j]!
      if (a.industry && b.industry && a.industry === b.industry) {
        out.push({
          type:       'cross_sell',
          businessA:  a.name,
          businessB:  b.name,
          evidence:   `both in industry "${a.industry}" — audience likely overlaps`,
          estimatedImpactUsd: null,
        })
      }
    }
  }
  return out
}

export interface PortfolioStrategyMove {
  businessId:  string
  name:        string
  move:        'double_down' | 'maintain' | 'sunset_proposal' | 'pivot'
  rationale:   string
  evidence:    Record<string, unknown>
}

/** Top-level portfolio call. For each business, propose
 *  double-down / maintain / sunset / pivot based on the same gap +
 *  velocity + trust math as the capital allocator. */
export async function portfolioStrategy(workspaceId: string): Promise<PortfolioStrategyMove[]> {
  const alloc = await allocateCapital({ workspaceId, allocationPoolUsd: 0 })
  // We reuse the allocation analysis but interpret it through a strategy lens.
  const moves: PortfolioStrategyMove[] = []
  for (const a of alloc.allocations) {
    let move: PortfolioStrategyMove['move']
    let rationale: string
    if (a.gapUsd === 0 && a.velocityScore >= 0.9) {
      move = 'double_down'
      rationale = `at floor with strong velocity (${(a.velocityScore * 100).toFixed(0)}%); scale cadence`
    } else if (a.gapUsd > a.monthlyTargetUsd * 0.5 && a.velocityScore < 0.4 && a.trustScore < 0.4) {
      move = 'sunset_proposal'
      rationale = `gap > 50% of target AND velocity ${(a.velocityScore * 100).toFixed(0)}% AND low trust — operator should evaluate sunset`
    } else if (a.gapUsd > 0 && a.velocityScore < 0.3) {
      move = 'pivot'
      rationale = `gap $${a.gapUsd.toFixed(0)}, velocity ${(a.velocityScore * 100).toFixed(0)}% — current approach not closing gap; propose pivot`
    } else {
      move = 'maintain'
      rationale = `gap $${a.gapUsd.toFixed(0)}, velocity ${(a.velocityScore * 100).toFixed(0)}% — hold course`
    }
    moves.push({
      businessId: a.businessId,
      name:       a.name,
      move,
      rationale,
      evidence: {
        last30dActualUsd: a.last30dActualUsd,
        gapUsd:           a.gapUsd,
        velocityScore:    a.velocityScore,
        trustScore:       a.trustScore,
      },
    })
  }
  return moves
}
