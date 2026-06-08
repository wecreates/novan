/**
 * R146.350 — Universal Goal Ladder
 *
 * Operator doctrine (importance 99):
 *   Every business pursues the same milestone ladder. Tier-specific tactics
 *   only unlock once the tier metric is hit. "Scaling before product-market
 *   fit" kills POD businesses — this ladder prevents that.
 *
 * Pull current MRR from business_revenue (existing table), compute which
 * tier each business is at, surface tier-appropriate tactics + the gap to
 * the next milestone.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export type MilestoneTier =
  | 'pre_first_sale'
  | 'first_sale_to_1k'
  | 'tier_1k'
  | 'tier_5k'
  | 'tier_10k'
  | 'tier_50k'
  | 'tier_100k'
  | 'tier_250k'
  | 'tier_500k'
  | 'tier_1m_plus'

export interface MilestoneRule {
  tier:              MilestoneTier
  mrrThresholdUsd:   number          // monthly recurring revenue floor
  label:             string
  unlockedTactics:   string[]
  blockedTactics:    string[]
}

export const LADDER: MilestoneRule[] = [
  {
    tier: 'pre_first_sale', mrrThresholdUsd: 0,
    label: 'Pre-first-sale',
    unlockedTactics: [
      '1 channel × 1 niche FOCUS - resist platform sprawl',
      'Upload 20-50 winners to highest-leverage platform (Gumroad / FAA / INPRNT)',
      'Learn what converts: study which listings get views vs sales',
      'Profile completeness on every signup; quality > quantity',
    ],
    blockedTactics: [
      'Bulk-replication across 5+ platforms',
      'Email list / SEO investment (no audience to send to yet)',
      'Paid storefronts (Shopify $39/mo) — wait until $1k MRR',
      'Paid ads (operator rule R350)',
    ],
  },
  {
    tier: 'first_sale_to_1k', mrrThresholdUsd: 1,
    label: 'First sale → $1k MRR',
    unlockedTactics: [
      'Generate variants of what sold (color shifts, crops, reframes)',
      'Double down on the winning niche - 5x the catalog there',
      'Expand to 2nd platform (replicate winners; do NOT spread thin)',
      'Capture buyer emails on every Gumroad sale - first ten = email list seed',
    ],
    blockedTactics: [
      'Pivoting to new niches before exhausting the winner',
      'Bulk-spray across 5+ platforms',
      'Premium-tier products (limited editions, signed prints) - not yet',
    ],
  },
  {
    tier: 'tier_1k', mrrThresholdUsd: 1000,
    label: '$1k MRR - first repeatability',
    unlockedTactics: [
      'Bulk-replicate winners across 5+ platforms (within R350 anti-flag rules)',
      'SEO investment: keyword research, alt text, structured tags',
      'Pinterest pinning for Gumroad / FAA traffic',
      'Open paid storefronts (Shopify $39/mo) if margins justify',
      'Newsletter cadence weekly - first 100 subscribers',
    ],
    blockedTactics: [
      'Sub-brand creation (still need one strong brand first)',
      'Wholesale outreach (catalog still too thin)',
      'Hiring help (not until $10k+)',
    ],
  },
  {
    tier: 'tier_5k', mrrThresholdUsd: 5000,
    label: '$5k MRR - first scaling',
    unlockedTactics: [
      'Catalog depth 200+ per primary platform',
      'Prompt-evolution: A/B test listing copy + image variants',
      'Audience-build via organic short-form (TikTok / Reels / Shorts) - 5/week',
      'Premium-tier products: signed limited editions, original commissions',
      'Email list: 500-1000 subscribers, monthly drops',
    ],
    blockedTactics: [
      'Paid ads (operator rule)',
      'International shipping complexity',
      'Live commerce / streaming (operator time-cost too high)',
    ],
  },
  {
    tier: 'tier_10k', mrrThresholdUsd: 10000,
    label: '$10k MRR - half-time income',
    unlockedTactics: [
      'Catalog depth 500+ per primary platform',
      'Prompt-evolution feedback loops fully wired',
      'Audience cross-pollination: feature buyers on social, build community',
      'Wholesale outreach to home-decor shops, frame stores',
      'Email list: 1k-3k subscribers, weekly drops',
      'Consider hiring a VA for listing-data entry on background platforms',
    ],
    blockedTactics: [
      'Brand acquisitions',
      'Paid ads still not opted in',
      'Storefront fragmentation (resist opening 10 new platforms)',
    ],
  },
  {
    tier: 'tier_50k', mrrThresholdUsd: 50000,
    label: '$50k MRR - team-grade output',
    unlockedTactics: [
      'Agency-style brand expansion: sub-brand per niche',
      'Hire 1-2 VAs for ops + 1 designer for finishing AI assets',
      'Premium tier: limited editions, signed series, originals',
      'Unlock paid storefronts AND keep all free ones running',
      'International markets: EU + UK fulfillment',
      'Conferences + craft fairs as discovery channels',
    ],
    blockedTactics: [
      'Acquisition spree (focus on internal scaling first)',
      'Tech-debt-heavy custom Shopify build (use Shopify default theme)',
    ],
  },
  {
    tier: 'tier_100k', mrrThresholdUsd: 100000,
    label: '$100k MRR - real business',
    unlockedTactics: [
      'Sub-brands per niche (CYZOR CREATIONS hub + niche-specific child brands)',
      'Licensing/wholesale agreements',
      'International markets at scale',
      'First paid-ads experiment if operator opts in (R350)',
      'Custom Shopify storefront with full brand',
      'Newsletter list: 10k+, segmented by buyer behavior',
    ],
    blockedTactics: [],
  },
  {
    tier: 'tier_250k', mrrThresholdUsd: 250000,
    label: '$250k MRR - portfolio scale',
    unlockedTactics: [
      'Acquire complementary businesses',
      'Dedicated product teams per niche',
      'Wholesale channel manager',
      'Brand partnerships',
    ],
    blockedTactics: [],
  },
  {
    tier: 'tier_500k', mrrThresholdUsd: 500000,
    label: '$500k MRR',
    unlockedTactics: ['Full agency / brand-house operation', 'M&A engine', 'Licensing IP'],
    blockedTactics: [],
  },
  {
    tier: 'tier_1m_plus', mrrThresholdUsd: 1000000,
    label: '$1M+ MRR',
    unlockedTactics: ['Full enterprise tactics unlocked', 'Operator chooses tactical mix'],
    blockedTactics: [],
  },
]

export function classifyTier(mrrUsd: number): MilestoneRule {
  // Find highest tier whose threshold is met
  let current = LADDER[0]!
  for (const tier of LADDER) {
    if (mrrUsd >= tier.mrrThresholdUsd) current = tier
  }
  return current
}

export function nextMilestone(mrrUsd: number): { current: MilestoneRule; next: MilestoneRule | null; gapUsd: number; percentToNext: number } {
  const current = classifyTier(mrrUsd)
  const next    = LADDER.find(t => t.mrrThresholdUsd > current.mrrThresholdUsd) ?? null
  const gapUsd  = next ? Math.max(0, next.mrrThresholdUsd - mrrUsd) : 0
  const denom = next ? (next.mrrThresholdUsd - current.mrrThresholdUsd) : 1
  const percentToNext = next ? Math.min(100, Math.max(0, 100 * (mrrUsd - current.mrrThresholdUsd) / denom)) : 100
  return { current, next, gapUsd, percentToNext: Number(percentToNext.toFixed(1)) }
}

// ─── Business-aware status (pulls real revenue from business_revenue) ──────

export interface BusinessGoalStatus {
  businessId:       string
  businessName?:    string
  mrrUsd30d:        number              // last 30-day MRR
  currentTier:      MilestoneRule
  nextTier:         MilestoneRule | null
  gapUsd:           number
  percentToNext:    number
  unlockedTactics:  string[]
  blockedTactics:   string[]
}

export async function businessGoalStatus(workspaceId: string, businessId?: string): Promise<BusinessGoalStatus[]> {
  const sinceMs = Date.now() - 30 * 24 * 3600 * 1000
  try {
    const rows = businessId
      ? await db.execute(sql`
          SELECT business_id, COALESCE(business_name, business_id) AS name,
                 COALESCE(SUM(net_usd), 0) AS mrr_30d
          FROM business_revenue
          WHERE workspace_id = ${workspaceId} AND business_id = ${businessId} AND recorded_at >= ${sinceMs}
          GROUP BY business_id, business_name
        `)
      : await db.execute(sql`
          SELECT business_id, COALESCE(business_name, business_id) AS name,
                 COALESCE(SUM(net_usd), 0) AS mrr_30d
          FROM business_revenue
          WHERE workspace_id = ${workspaceId} AND recorded_at >= ${sinceMs}
          GROUP BY business_id, business_name
          ORDER BY mrr_30d DESC
        `)
    const out: BusinessGoalStatus[] = []
    for (const r of rows as unknown as Array<{ business_id: string; name: string; mrr_30d: number }>) {
      const mrr = Number(r.mrr_30d) || 0
      const status = nextMilestone(mrr)
      out.push({
        businessId:      r.business_id,
        businessName:    r.name,
        mrrUsd30d:       mrr,
        currentTier:     status.current,
        nextTier:        status.next,
        gapUsd:          status.gapUsd,
        percentToNext:   status.percentToNext,
        unlockedTactics: status.current.unlockedTactics,
        blockedTactics:  status.current.blockedTactics,
      })
    }
    // If no businesses recorded revenue, still return one stub at pre_first_sale
    if (out.length === 0) {
      const stub = nextMilestone(0)
      out.push({
        businessId:      'unset',
        businessName:    'No business with recorded revenue yet',
        mrrUsd30d:       0,
        currentTier:     stub.current,
        nextTier:        stub.next,
        gapUsd:          stub.gapUsd,
        percentToNext:   stub.percentToNext,
        unlockedTactics: stub.current.unlockedTactics,
        blockedTactics:  stub.current.blockedTactics,
      })
    }
    return out
  } catch (e) {
    console.error('[r350-goal-ladder] businessGoalStatus failed:', (e as Error).message)
    return []
  }
}
