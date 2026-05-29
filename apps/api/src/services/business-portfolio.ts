/**
 * business-portfolio.ts — Track every business against the $10k/mo floor.
 *
 * One row in `businesses` per "thing that should make $10k/mo on its own"
 * (a YouTube portfolio, an Etsy shop, a newsletter, a SaaS funnel, …).
 *
 * Revenue lands in `business_revenue` as append-only rows tied to an
 * `earnings_month` (the operator-facing month of record — YouTube pays
 * May in July, but the row's earnings_month is '2026-05'). The brain
 * computes running totals by aggregating.
 *
 * The target lives in businesses.metrics.monthlyTargetUsd. We default
 * to 10_000 if absent so legacy rows from the existing
 * business-construction service automatically inherit the goal.
 *
 * Brain-task ops exposed (wired in brain-task.ts):
 *   portfolio.list          — every business + 30-day run-rate vs target
 *   portfolio.status        — single business deep status
 *   portfolio.recordRevenue — append a revenue event
 *   portfolio.targetGap     — for each business, dollars short of $10k/mo
 *   portfolio.weeklyReview  — compose the Monday briefing per the playbook
 */
import { v7 as uuidv7 }           from 'uuid'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db }                     from '../db/client.js'
import { businesses, businessRevenue, events } from '../db/schema.js'

export type RevenueKind = 'ad_share' | 'sale' | 'sponsorship' | 'affiliate' | 'tip' | 'refund' | 'other'

const DEFAULT_TARGET_USD = 10_000

/** YYYY-MM stamp for `now`. Stable across timezones (UTC). */
export function earningsMonth(at: number = Date.now()): string {
  const d = new Date(at)
  const yy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${yy}-${mm}`
}

/** Read the target from businesses.metrics.monthlyTargetUsd, default $10k. */
function targetFromMetrics(metrics: Record<string, unknown> | null | undefined): number {
  if (!metrics) return DEFAULT_TARGET_USD
  const raw = (metrics as { monthlyTargetUsd?: unknown }).monthlyTargetUsd
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TARGET_USD
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'business-portfolio', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Revenue ledger ─────────────────────────────────────────────────────────

export interface RecordRevenueInput {
  workspaceId:    string
  businessId:     string
  kind:           RevenueKind
  amountUsd:      number     // human dollars; converted to cents internally
  source?:        string     // 'youtube' | 'etsy' | 'stripe' | …
  sourceRef?:     string
  earningsMonth?: string     // defaults to current UTC month
  landedAt?:      number
}

/** Append a revenue event. Returns the new row id. */
export async function recordRevenue(input: RecordRevenueInput): Promise<string> {
  const id = uuidv7()
  const cents = Math.round(input.amountUsd * 100)
  const row: typeof businessRevenue.$inferInsert = {
    id,
    workspaceId:    input.workspaceId,
    businessId:     input.businessId,
    kind:           input.kind,
    amountUsdCents: cents,
    earningsMonth:  input.earningsMonth ?? earningsMonth(),
    recordedAt:     Date.now(),
  }
  if (input.source    !== undefined) row.source    = input.source
  if (input.sourceRef !== undefined) row.sourceRef = input.sourceRef
  if (input.landedAt  !== undefined) row.landedAt  = input.landedAt
  await db.insert(businessRevenue).values(row)
  await emit(input.workspaceId, 'business.revenue.recorded', {
    businessId: input.businessId, kind: input.kind, amountUsd: input.amountUsd,
    earningsMonth: row.earningsMonth, source: input.source,
  })
  return id
}

// ─── Portfolio status ───────────────────────────────────────────────────────

export interface BusinessStatus {
  id:                 string
  name:               string
  category:           string
  enabled:            boolean
  monthlyTargetUsd:   number
  currentMonth:       string
  currentMonthUsd:    number          // gross revenue this month
  last30DaysUsd:      number          // rolling 30-day window
  last7DaysUsd:       number
  runRateUsd:         number          // last30Days / 30 * 30 (same; kept explicit for clarity)
  targetGapUsd:       number          // max(0, target - last30DaysUsd)
  targetPct:          number          // last30DaysUsd / target, capped at 2.0 for display
  trajectoryUsd:      number          // last7Days * 30/7 ; projection from recent velocity
  phase:              string          // metrics.phase if set, else 'warm-up'
  needsAttention:     boolean         // true if behind target AND trajectory is also short
  reasons:            string[]        // 1-line explanations for the operator
}

/** Compute one business's status. */
export async function statusFor(workspaceId: string, businessId: string): Promise<BusinessStatus | null> {
  const [b] = await db.select().from(businesses)
    .where(and(eq(businesses.workspaceId, workspaceId), eq(businesses.id, businessId)))
    .limit(1)
  if (!b) return null

  const now = Date.now()
  const month = earningsMonth(now)
  const since30 = now - 30 * 86_400_000
  const since7  = now -  7 * 86_400_000

  const monthSum = await db
    .select({ cents: sql<number>`COALESCE(SUM(${businessRevenue.amountUsdCents}), 0)::bigint` })
    .from(businessRevenue)
    .where(and(
      eq(businessRevenue.businessId, businessId),
      eq(businessRevenue.earningsMonth, month),
    ))
  const win30 = await db
    .select({ cents: sql<number>`COALESCE(SUM(${businessRevenue.amountUsdCents}), 0)::bigint` })
    .from(businessRevenue)
    .where(and(
      eq(businessRevenue.businessId, businessId),
      gte(businessRevenue.recordedAt, since30),
    ))
  const win7 = await db
    .select({ cents: sql<number>`COALESCE(SUM(${businessRevenue.amountUsdCents}), 0)::bigint` })
    .from(businessRevenue)
    .where(and(
      eq(businessRevenue.businessId, businessId),
      gte(businessRevenue.recordedAt, since7),
    ))

  const target    = targetFromMetrics(b.metrics as Record<string, unknown>)
  const month$    = Number(monthSum[0]?.cents ?? 0) / 100
  const day30$    = Number(win30[0]?.cents ?? 0) / 100
  const day7$     = Number(win7[0]?.cents ?? 0) / 100
  const traj$     = day7$ * (30 / 7)
  const gap$      = Math.max(0, target - day30$)
  const phase     = String((b.metrics as { phase?: unknown } | null)?.phase ?? 'warm-up')

  const reasons: string[] = []
  if (day30$ >= target) {
    reasons.push(`hit target (last 30d = $${day30$.toFixed(0)} vs $${target} goal)`)
  } else if (traj$ >= target) {
    reasons.push(`behind target now ($${day30$.toFixed(0)}) but on pace from recent velocity ($${traj$.toFixed(0)}/mo projected)`)
  } else {
    reasons.push(`short of target: $${gap$.toFixed(0)} to close, last 30d $${day30$.toFixed(0)}, projection $${traj$.toFixed(0)}/mo`)
  }
  if (!(b.health !== 'red'))            reasons.push('business is disabled — no production scheduled')
  if (phase === 'sunset')    reasons.push('phase=sunset — operator marked for shutdown')

  const needsAttention = (b.health !== 'red') && day30$ < target && traj$ < target

  return {
    id: b.id,
    name: b.name,
    category: b.industry ?? 'mixed',
    enabled: (b.health !== 'red'),
    monthlyTargetUsd: target,
    currentMonth: month,
    currentMonthUsd:  month$,
    last30DaysUsd:    day30$,
    last7DaysUsd:     day7$,
    runRateUsd:       day30$,
    targetGapUsd:     gap$,
    targetPct:        target > 0 ? Math.min(2, day30$ / target) : 0,
    trajectoryUsd:    traj$,
    phase,
    needsAttention,
    reasons,
  }
}

/** Status for every business in the workspace. Used by portfolio.list and
 *  the Monday weekly review. */
export async function listStatuses(workspaceId: string): Promise<BusinessStatus[]> {
  const rows = await db.select({ id: businesses.id }).from(businesses)
    .where(eq(businesses.workspaceId, workspaceId))
    .orderBy(desc(businesses.updatedAt))
    .limit(100)
  const out: BusinessStatus[] = []
  for (const r of rows) {
    const s = await statusFor(workspaceId, r.id)
    if (s) out.push(s)
  }
  return out
}

// ─── Weekly review ──────────────────────────────────────────────────────────

export interface WeeklyReview {
  workspaceId:        string
  generatedAt:        number
  businessCount:      number
  totalMonthlyUsd:    number
  totalTargetUsd:     number
  pctToCombinedGoal:  number
  underperforming:    BusinessStatus[]   // needsAttention === true
  onTrack:            BusinessStatus[]
  sunsetCandidates:   BusinessStatus[]   // phase==='warm-up' and 60+ days old and < 10% target
  actionable:         string[]           // 1-line action items for the operator
}

/** Compose the operator-facing Monday briefing.
 *  Used by both the brain-task op `portfolio.weeklyReview` and the
 *  continuous-improvement cron. */
export async function weeklyReview(workspaceId: string): Promise<WeeklyReview> {
  const all = await listStatuses(workspaceId)
  const totalMonth$  = all.reduce((acc, b) => acc + b.last30DaysUsd, 0)
  const totalTarget$ = all.reduce((acc, b) => acc + b.monthlyTargetUsd, 0)
  const underperforming = all.filter(b => b.needsAttention)
  const onTrack         = all.filter(b => !b.needsAttention && b.enabled)
  const sunsetCandidates = all.filter(b => b.phase === 'warm-up' && b.last30DaysUsd < b.monthlyTargetUsd * 0.10)

  const actionable: string[] = []
  if (all.length === 0) {
    actionable.push('No businesses tracked. Create one with `portfolio.create` and the brain can start planning.')
  }
  for (const u of underperforming.slice(0, 5)) {
    actionable.push(`${u.name}: $${u.targetGapUsd.toFixed(0)} short of $${u.monthlyTargetUsd}/mo — needs format pivot or output increase`)
  }
  for (const s of sunsetCandidates.slice(0, 3)) {
    actionable.push(`${s.name}: at <10% of target after warm-up — propose sunset or niche pivot`)
  }
  if (onTrack.length > 0 && underperforming.length === 0) {
    actionable.push(`All ${onTrack.length} active businesses on track — consider opening a new business to diversify`)
  }

  return {
    workspaceId,
    generatedAt: Date.now(),
    businessCount: all.length,
    totalMonthlyUsd:   totalMonth$,
    totalTargetUsd:    totalTarget$,
    pctToCombinedGoal: totalTarget$ > 0 ? totalMonth$ / totalTarget$ : 0,
    underperforming,
    onTrack,
    sunsetCandidates,
    actionable,
  }
}

// ─── Target updates ─────────────────────────────────────────────────────────

/** Adjust a business's monthly target. We refuse to set below 10000 — the
 *  $10k/mo floor is a deliberate constraint of the platform's goal, not
 *  a soft preference. Raise it freely once the operator clears the floor. */
export async function setMonthlyTarget(workspaceId: string, businessId: string, targetUsd: number): Promise<{ ok: boolean; effectiveTarget: number; reason?: string }> {
  if (!Number.isFinite(targetUsd) || targetUsd < DEFAULT_TARGET_USD) {
    return {
      ok: false,
      effectiveTarget: DEFAULT_TARGET_USD,
      reason: `target must be ≥ $${DEFAULT_TARGET_USD} (platform-wide $10k/mo floor)`,
    }
  }
  const [b] = await db.select().from(businesses)
    .where(and(eq(businesses.workspaceId, workspaceId), eq(businesses.id, businessId)))
    .limit(1)
  if (!b) return { ok: false, effectiveTarget: DEFAULT_TARGET_USD, reason: 'business not found' }
  const metrics = { ...(b.metrics as Record<string, unknown>), monthlyTargetUsd: targetUsd }
  await db.update(businesses).set({ metrics, updatedAt: Date.now() })
    .where(eq(businesses.id, businessId))
  return { ok: true, effectiveTarget: targetUsd }
}
