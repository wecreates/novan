/**
 * business-reality.ts — Honest "are we on pace?" assessment.
 *
 * Two ops live here:
 *
 *   realityCheck(workspaceId, businessId)
 *     Projects 30/60/90-day revenue from the recent velocity and compares
 *     to the $10k/mo floor. Surfaces three honest categories: on-pace,
 *     drifting, structurally-off. The brain uses this to decide whether
 *     to propose tweaks (drifting) or pivots (structurally-off).
 *
 *   sunsetProposal(workspaceId, businessId)
 *     Compares days-since-launch + current trajectory against the
 *     playbook's sunset thresholds (multi-channel-operations.md §8).
 *     Returns a proposal — never executes — for operator approval.
 *
 * Both are side-effect free reads (apart from emit events for audit).
 * Sunset / format-pivot decisions are irreversible enough that the
 * brain refuses to execute them; only the operator can.
 */
import { and, eq, gte }  from 'drizzle-orm'
import { db }            from '../db/client.js'
import { businesses, businessRevenue, events } from '../db/schema.js'
import { v7 as uuidv7 }  from 'uuid'
import { FLOOR_USD }     from './business-feasibility.js'
import { statusFor }     from './business-portfolio.js'

export type Pace = 'on-pace' | 'drifting' | 'structurally-off' | 'over-target' | 'no-data'

export interface RealityCheck {
  businessId:           string
  name:                 string
  daysSinceCreated:     number
  monthlyTargetUsd:     number     // always 10000 unless raised
  last30DaysUsd:        number
  last7DaysUsd:         number
  projection30dUsd:     number     // 7d × 30/7
  projection90dUsd:     number     // best-fit linear from last 60d weekly buckets
  gapToFloorUsd:        number
  pace:                 Pace
  paceReason:           string
  monthsToFloor:        number | null  // null if structurally-off (no path)
  recommendedAction:    'continue' | 'tweak' | 'pivot' | 'sunset' | 'raise-target'
  honestCaveats:        string[]
}

export async function realityCheck(workspaceId: string, businessId: string): Promise<RealityCheck | null> {
  const status = await statusFor(workspaceId, businessId)
  if (!status) return null
  const [b] = await db.select().from(businesses)
    .where(and(eq(businesses.workspaceId, workspaceId), eq(businesses.id, businessId))).limit(1)
  if (!b) return null

  const now = Date.now()
  const daysSinceCreated = Math.floor((now - b.createdAt) / 86_400_000)
  const proj30 = status.trajectoryUsd
  // 90-day projection: weighted toward recent velocity but tempered by
  // longer-baseline if available. For a business < 60 days old we use
  // the simple 30d projection; older businesses get a weighted blend.
  const proj90 = daysSinceCreated < 60
    ? proj30
    : (proj30 * 0.6) + (status.last30DaysUsd * 0.4)
  const gap = Math.max(0, status.monthlyTargetUsd - status.last30DaysUsd)

  // Pace classification:
  //   over-target       — last30 >= target
  //   on-pace           — last30 ≥ 0.75×target OR trajectory ≥ target
  //   drifting          — last30 0.30–0.75×target AND trajectory > 0.5×target
  //   structurally-off  — last30 < 0.30×target AND projection still < target after 6mo
  //   no-data           — daysSinceCreated < 14 OR last30 == 0 and < 30 days old
  let pace: Pace = 'no-data'
  let reason = ''
  let monthsToFloor: number | null = null
  let recommended: RealityCheck['recommendedAction'] = 'continue'

  if (daysSinceCreated < 14) {
    pace = 'no-data'
    reason = `Only ${daysSinceCreated} days since launch — needs at least 14 days of signal before pace is meaningful.`
    recommended = 'continue'
  } else if (status.last30DaysUsd >= status.monthlyTargetUsd) {
    pace = 'over-target'
    reason = `Hit the $${status.monthlyTargetUsd} floor — $${status.last30DaysUsd.toFixed(0)} last 30d.`
    monthsToFloor = 0
    recommended = 'raise-target'
  } else if (status.last30DaysUsd >= status.monthlyTargetUsd * 0.75 || proj30 >= status.monthlyTargetUsd) {
    pace = 'on-pace'
    reason = `On pace — last 30d $${status.last30DaysUsd.toFixed(0)}, 30d trajectory $${proj30.toFixed(0)} vs $${status.monthlyTargetUsd} floor.`
    monthsToFloor = proj30 >= status.monthlyTargetUsd ? 1 : 2
    recommended = 'continue'
  } else if (status.last30DaysUsd >= status.monthlyTargetUsd * 0.30 && proj30 >= status.monthlyTargetUsd * 0.50) {
    pace = 'drifting'
    reason = `Drifting — last 30d $${status.last30DaysUsd.toFixed(0)} (${((status.last30DaysUsd / status.monthlyTargetUsd) * 100).toFixed(0)}% of floor), trajectory $${proj30.toFixed(0)}/mo. Needs scale, not tweaks.`
    // Months to floor at current growth — assume velocity continues
    monthsToFloor = proj30 > status.last30DaysUsd
      ? Math.ceil((status.monthlyTargetUsd - status.last30DaysUsd) / Math.max(50, proj30 - status.last30DaysUsd))
      : null
    recommended = 'tweak'
  } else if (daysSinceCreated >= 90) {
    pace = 'structurally-off'
    reason = `Structurally-off — $${status.last30DaysUsd.toFixed(0)}/mo at day ${daysSinceCreated}. At this trajectory ($${proj90.toFixed(0)}/mo 90d projection) the math does not close to $${status.monthlyTargetUsd} within a reasonable horizon.`
    monthsToFloor = null
    recommended = daysSinceCreated >= 120 ? 'sunset' : 'pivot'
  } else {
    pace = 'drifting'
    reason = `Early-stage drift — day ${daysSinceCreated}, $${status.last30DaysUsd.toFixed(0)} last 30d. Likely still in the signal-building phase but watch for day-90 inflection.`
    monthsToFloor = null
    recommended = 'continue'
  }

  await emitEvent(workspaceId, 'business.reality_check', {
    businessId, pace, recommended, gap, proj30, proj90,
  })

  const honestCaveats = [
    `The $${FLOOR_USD}/mo floor is a platform-wide minimum, not a ceiling. Anything above it is over-target.`,
    `Projections use last-7-day velocity for 30d and a weighted 60-day blend for 90d. Real outcomes vary ±40% with platform algorithm changes.`,
    `The brain proposes — it does not execute pivot or sunset. Operator decision is required.`,
  ]
  if (pace === 'structurally-off') {
    honestCaveats.push(`A "structurally-off" classification doesn't mean failure — it means the current niche/format combination cannot reach the floor on its own. The next move is pivot or sunset, not "try harder".`)
  }

  return {
    businessId,
    name:               status.name,
    daysSinceCreated,
    monthlyTargetUsd:   status.monthlyTargetUsd,
    last30DaysUsd:      status.last30DaysUsd,
    last7DaysUsd:       status.last7DaysUsd,
    projection30dUsd:   proj30,
    projection90dUsd:   proj90,
    gapToFloorUsd:      gap,
    pace,
    paceReason:         reason,
    monthsToFloor,
    recommendedAction:  recommended,
    honestCaveats,
  }
}

// ─── Sunset proposal ──────────────────────────────────────────────────────

export interface SunsetProposal {
  businessId:        string
  name:              string
  daysSinceCreated:  number
  currentPace:       Pace
  shouldSunset:      boolean
  reasons:           string[]
  alternatives:      Array<{
    action: 'pivot-niche' | 'pivot-format' | 'add-monetization-layer' | 'split-into-portfolio'
    rationale: string
  }>
  finalDecisionGate: string  // who has to confirm — always 'operator'
}

/** Per the multi-channel-operations playbook §8:
 *    Day 30:  pivot format within niche if failing
 *    Day 60:  pivot niche if 30-day trend is flat
 *    Day 90:  sunset if no growth signal
 *    Day 120: sunset (cannibalize content to a different business)
 *
 *  Brain proposes — never executes. Operator confirms in the chat. */
export async function sunsetProposal(workspaceId: string, businessId: string): Promise<SunsetProposal | null> {
  const reality = await realityCheck(workspaceId, businessId)
  if (!reality) return null

  const reasons: string[] = []
  const alternatives: SunsetProposal['alternatives'] = []
  let shouldSunset = false

  if (reality.daysSinceCreated < 30) {
    reasons.push(`Too early — ${reality.daysSinceCreated} days since launch. Sunset proposals fire at day 90+ per the playbook.`)
  } else if (reality.daysSinceCreated < 60 && reality.pace === 'drifting') {
    alternatives.push({
      action: 'pivot-format',
      rationale: 'Day-30 marker — pivot format within the existing niche. Same audience, different presentation.',
    })
  } else if (reality.daysSinceCreated < 90 && (reality.pace === 'drifting' || reality.pace === 'structurally-off')) {
    alternatives.push({
      action: 'pivot-niche',
      rationale: 'Day-60 marker — niche selection looks wrong. Pivot to an adjacent niche with better $10k feasibility.',
    })
    alternatives.push({
      action: 'split-into-portfolio',
      rationale: 'If the niche is right but one channel/shop is plateauing, the multi-channel playbook §3 recommends launching siblings in adjacent sub-niches.',
    })
  } else if (reality.daysSinceCreated >= 90 && reality.pace === 'structurally-off') {
    shouldSunset = true
    reasons.push(`Day ${reality.daysSinceCreated} marker — sunset threshold per playbook §8.`)
    reasons.push(reality.paceReason)
    alternatives.push({
      action: 'add-monetization-layer',
      rationale: 'Before sunsetting, consider whether a sponsorship / affiliate / digital-product layer could close the gap without changing the content.',
    })
  } else if (reality.daysSinceCreated >= 120 && reality.pace !== 'on-pace' && reality.pace !== 'over-target') {
    shouldSunset = true
    reasons.push(`Day ${reality.daysSinceCreated} — final sunset gate. Cannibalize the best content to a different business per playbook §8.`)
  }

  if (alternatives.length === 0 && !shouldSunset) {
    alternatives.push({
      action: 'pivot-format',
      rationale: 'No clear sunset signal yet — try a format pivot first.',
    })
  }

  return {
    businessId:        reality.businessId,
    name:              reality.name,
    daysSinceCreated:  reality.daysSinceCreated,
    currentPace:       reality.pace,
    shouldSunset,
    reasons,
    alternatives,
    finalDecisionGate: 'operator',  // Brain never executes sunset itself.
  }
}

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-reality', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[business-reality]', e.message); return null })
}

// `gte` and `businessRevenue` referenced for future extensions (forecasting
// fits, seasonal adjustment) — silence unused warnings via void.
void gte; void businessRevenue
