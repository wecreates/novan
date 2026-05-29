/**
 * executive-loop.ts — Recurring executive review cycle.
 *
 * Cycles:
 *   - hourly      → runtime health review (cheap)
 *   - six_hourly  → operational optimization review
 *   - daily       → strategic review (delegates to daily-review)
 *   - weekly      → roadmap review (delegates to weekly briefing)
 *
 * Each review:
 *   1. snapshots executive_state before
 *   2. analyzes real signals (incidents, forecasts, recommendations)
 *   3. produces an updated executive_state
 *   4. persists to executive_review_log
 *   5. records reasoning chain so meta-reasoning can score later
 */
import { db }                          from '../db/client.js'
import {
  executiveState, executiveReviewLog, events, incidents, auditFindings,
  providerBudgets, strategicGoals, patchApprovals,
} from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'
import { topRecommendations }          from './recommendation-engine.js'
import { generateForecasts }           from './forecasting.js'
import { record as recordChain }       from './reasoning-chains.js'
import { stabilitySnapshot }           from './governance-core.js'

const HOUR = 60 * 60_000

export type ReviewCycle = 'hourly' | 'six_hourly' | 'daily' | 'weekly'

export interface ReviewResult {
  cycle:           ReviewCycle
  workspaceId:     string
  reviewedAt:      number
  signalsAnalyzed: Record<string, unknown>
  prioritiesBefore: string[]
  prioritiesAfter:  string[]
  actionsRecommended: Array<{ kind: string; title: string; bucket: string }>
  chainId:         string | null
}

async function readState(workspaceId: string) {
  return db.select().from(executiveState).where(eq(executiveState.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })
}

async function writeState(workspaceId: string, patch: {
  topPriorities?:      unknown[]
  activeRisks?:        unknown[]
  strategicObjectives?: unknown[]
  blockedInitiatives?: unknown[]
  costPosture?:        unknown
  reliabilityPosture?: unknown
  securityPosture?:    unknown
  focusAreas?:         string[]
  lastReviewAt?:       number
  reviewCount?:        number
}) {
  const existing = await readState(workspaceId)
  const now = Date.now()
  if (!existing) {
    await db.insert(executiveState).values({
      workspaceId,
      topPriorities:       (patch.topPriorities ?? []) as never,
      activeRisks:         (patch.activeRisks ?? []) as never,
      strategicObjectives: (patch.strategicObjectives ?? []) as never,
      blockedInitiatives:  (patch.blockedInitiatives ?? []) as never,
      costPosture:         (patch.costPosture ?? null) as never,
      reliabilityPosture:  (patch.reliabilityPosture ?? null) as never,
      securityPosture:     (patch.securityPosture ?? null) as never,
      focusAreas:          patch.focusAreas ?? [],
      lastReviewAt:        patch.lastReviewAt ?? now,
      reviewCount:         patch.reviewCount ?? 1,
      updatedAt:           now,
    }).onConflictDoNothing().catch((e: Error) => { console.error('[executive-loop]', e.message); return null })
  } else {
    const update: Record<string, unknown> = { updatedAt: now, lastReviewAt: patch.lastReviewAt ?? now, reviewCount: (existing.reviewCount ?? 0) + 1 }
    for (const k of ['topPriorities', 'activeRisks', 'strategicObjectives', 'blockedInitiatives', 'costPosture', 'reliabilityPosture', 'securityPosture', 'focusAreas'] as const) {
      const v = patch[k]
      if (v !== undefined) update[k] = v
    }
    await db.update(executiveState).set(update).where(eq(executiveState.workspaceId, workspaceId)).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })
  }
}

// ─── Cycle implementations ──────────────────────────────────────────────────

export async function runHourlyHealthReview(workspaceId: string): Promise<ReviewResult> {
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  recordAgentActivityAsync(workspaceId, 'research_planner', { status: 'running' })
  const stab = await stabilitySnapshot(workspaceId).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })
  const before = await readState(workspaceId)
  const beforePrio = (before?.topPriorities ?? []) as Array<{ title: string }>
  const prioritiesBefore = beforePrio.map(p => p.title)

  const signals = {
    stability:           stab?.overall ?? 'unknown',
    recommendedThrottle: stab?.recommendedThrottle ?? false,
    unstable:            stab?.indicators?.filter(i => i.unstable).map(i => i.name) ?? [],
  }
  const newRisks = (stab?.indicators ?? []).filter(i => i.unstable).map(i => ({ name: i.name, value: i.value, threshold: i.threshold, detail: i.detail }))

  const result = await persistReview(workspaceId, 'hourly', signals, prioritiesBefore, prioritiesBefore, [])
  await writeState(workspaceId, { activeRisks: newRisks })
  return result
}

export async function runSixHourlyOperationalReview(workspaceId: string): Promise<ReviewResult> {
  const recs = await topRecommendations(workspaceId, 5).catch(() => [])
  const forecasts = await generateForecasts(workspaceId).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })

  const before = await readState(workspaceId)
  const beforePrio = (before?.topPriorities ?? []) as Array<{ title: string }>
  const prioritiesBefore = beforePrio.map(p => p.title)

  const newPriorities = recs.slice(0, 5).map(r => ({ title: r.title, kind: r.kind, bucket: r.decision.bucket, score: r.decision.score }))
  const prioritiesAfter = newPriorities.map(p => p.title)

  const signals = {
    topRecCount: recs.length,
    forecastSummary: forecasts?.summary ?? null,
  }
  const actions = recs.map(r => ({ kind: r.kind, title: r.title, bucket: r.decision.bucket }))
  const result = await persistReview(workspaceId, 'six_hourly', signals, prioritiesBefore, prioritiesAfter, actions)
  await writeState(workspaceId, { topPriorities: newPriorities })
  return result
}

export async function runDailyStrategicReview(workspaceId: string): Promise<ReviewResult> {
  // Pull strategic objectives from active missions
  const goals = await db.select().from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
    .orderBy(strategicGoals.targetDate).limit(10).catch(() => [])
  const objectives = goals.map(g => ({
    id: g.id, title: String(g.title ?? ''), horizon: g.horizon, progress: Number(g.progress ?? 0),
  }))

  // Blocked = paused
  const blocked = await db.select().from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'paused')))
    .limit(10).catch(() => [])
  const blockedInits = blocked.map(g => ({ id: g.id, title: String(g.title ?? '') }))

  // Cost posture
  const budget = await db.select().from(providerBudgets)
    .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })
  const costPosture = budget ? {
    dailyLimitUsd: Number(budget.dailyLimitUsd), dailySpendUsd: Number(budget.dailySpendUsd),
    dailyPct: budget.dailyLimitUsd > 0 ? Number((budget.dailySpendUsd / budget.dailyLimitUsd).toFixed(3)) : 0,
  } : null

  // Reliability posture: open incidents + audit findings
  const openInc = await db.select({ c: sql<number>`count(*)::int` }).from(incidents)
    .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  const reliabilityPosture = { openIncidents: openInc }

  // Security posture
  const secFindings = await db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
    .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  const securityPosture = { auditFindings: secFindings }

  const before = await readState(workspaceId)
  const beforePrio = (before?.topPriorities ?? []) as Array<{ title: string }>
  const prioritiesBefore = beforePrio.map(p => p.title)

  const signals = {
    activeMissions: goals.length, blockedMissions: blocked.length,
    costPosture, reliabilityPosture, securityPosture,
  }
  const result = await persistReview(workspaceId, 'daily', signals, prioritiesBefore, prioritiesBefore, [])
  await writeState(workspaceId, {
    strategicObjectives: objectives, blockedInitiatives: blockedInits,
    costPosture, reliabilityPosture, securityPosture,
    focusAreas: objectives.length > 0 ? ['mission_delivery'] : ['stability'],
  })
  return result
}

export async function runWeeklyRoadmapReview(workspaceId: string): Promise<ReviewResult> {
  const pending = await db.select({ c: sql<number>`count(*)::int` }).from(patchApprovals)
    .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)

  const before = await readState(workspaceId)
  const beforePrio = (before?.topPriorities ?? []) as Array<{ title: string }>
  const signals = { pendingApprovals: pending }
  return persistReview(workspaceId, 'weekly', signals, beforePrio.map(p => p.title), beforePrio.map(p => p.title), [])
}

async function persistReview(
  workspaceId: string, cycle: ReviewCycle,
  signalsAnalyzed: Record<string, unknown>,
  prioritiesBefore: string[], prioritiesAfter: string[],
  actionsRecommended: Array<{ kind: string; title: string; bucket: string }>,
): Promise<ReviewResult> {
  const now = Date.now()
  const id = uuidv7()
  await db.insert(executiveReviewLog).values({
    id, workspaceId, cycle, triggeredBy: 'cron',
    signalsAnalyzed: signalsAnalyzed as never,
    prioritiesBefore: prioritiesBefore as never,
    prioritiesAfter:  prioritiesAfter as never,
    actionsRecommended: actionsRecommended as never,
    createdAt: now,
  }).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })

  // Record reasoning chain so meta-reasoning can score these reviews later
  const chainId = await recordChain({
    workspaceId,
    kind: 'decision',
    subjectId: id,
    decision: `Executive ${cycle} review: ${actionsRecommended.length} actions recommended; priorities ${JSON.stringify(prioritiesAfter).slice(0, 200)}`,
    evidence: Object.entries(signalsAnalyzed).slice(0, 6).map(([k, v]) => ({ type: 'signal', id: k, extract: JSON.stringify(v).slice(0, 120) })),
    prediction: { actionsRecommended, focusAreaPersistent: prioritiesAfter },
    source: 'executive-loop',
  })

  // Emit runtime event
  await db.insert(events).values({
    id: uuidv7(), type: `executive.${cycle}_review_completed`, workspaceId,
    payload: { cycle, signals: signalsAnalyzed, prioritiesAfter, actionsRecommended, reviewLogId: id, chainId },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'executive-loop', version: 1, createdAt: now,
  }).catch((e: Error) => { console.error('[executive-loop]', e.message); return null })

  return { cycle, workspaceId, reviewedAt: now, signalsAnalyzed, prioritiesBefore, prioritiesAfter, actionsRecommended, chainId }
}

export async function getExecutiveState(workspaceId: string) {
  const row = await readState(workspaceId)
  if (!row) return null
  return {
    workspaceId: row.workspaceId,
    topPriorities:       row.topPriorities,
    activeRisks:         row.activeRisks,
    strategicObjectives: row.strategicObjectives,
    blockedInitiatives:  row.blockedInitiatives,
    costPosture:         row.costPosture,
    reliabilityPosture:  row.reliabilityPosture,
    securityPosture:     row.securityPosture,
    focusAreas:          row.focusAreas,
    lastReviewAt:        row.lastReviewAt,
    reviewCount:         row.reviewCount,
    updatedAt:           row.updatedAt,
  }
}

export async function recentReviews(workspaceId: string, limit = 20) {
  return db.select().from(executiveReviewLog)
    .where(eq(executiveReviewLog.workspaceId, workspaceId))
    .orderBy(sql`${executiveReviewLog.createdAt} desc`)
    .limit(limit).catch(() => [])
}
