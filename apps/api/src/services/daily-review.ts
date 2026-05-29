/**
 * daily-review.ts — Once-per-day summary of the autonomous system's state.
 *
 * Pulls top failures, top wins, top costs, top learning insights, top
 * blockers from real runtime tables and emits a single 'daily.review'
 * event with the digest. Lightweight — pure SELECTs, no LLM call.
 *
 * Idempotency: skips if a review was emitted in the last 23 hours.
 */
import { db }                     from '../db/client.js'
import {
  events, incidents, researchFindings, imageGenerations,
  auditFindings, failureMemory, successfulFixes,
  patchApprovals, roadmapTasks, providerBudgets,
  workflowRuns, strategicGoals,
} from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 }            from 'uuid'

export interface DailyReview {
  workspaceId:     string
  windowStart:     number
  windowEnd:       number
  topFailures:     Array<{ signature: string; occurrences: number }>
  topWins:         Array<{ description: string; appliedCount: number }>
  topCosts:        Array<{ provider: string; spendUsd: number; count: number }>
  topInsights:     Array<{ summary: string; sourceUrl: string; confidence: number }>
  topBlockers:     Array<{ title: string; severity: string }>
  pendingApprovals: Array<{ id: string; reason: string; createdAt: number }>
  topPriorities:   Array<{ title: string; category: string; priorityScore: number; phase: string }>
  providerHealth:  { connected: number; degraded: number; unconfigured: number; flags: { researchEnabled: boolean; imageGenerationEnabled: boolean } }
  budgetUsage:     { dailyPct: number; monthlyPct: number; alertThreshold: number } | null
  rollbackEvents:  number
  failedWorkflows: number
  securityFindings: number
  missionProgress: { active: number; avgProgress: number; completedToday: number }
  nextRecommended: string[]
}

export async function alreadyEmittedToday(workspaceId: string): Promise<boolean> {
  const since = Date.now() - 23 * 60 * 60_000
  const row = await db.select({ id: events.id }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'daily.review'),
      gte(events.createdAt, since),
    ))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[daily-review]', e.message); return null })
  return !!row
}

export async function generateDailyReview(workspaceId: string): Promise<DailyReview> {
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60_000

  const [failures, wins, imageSpend, insights, openIncidents, audit, pending, priorities,
         budgetRow, rollbackCount, failedWorkflowCount, securityFindings, missionAgg] = await Promise.all([
    db.select({
      signature: failureMemory.signature,
      occurrences: failureMemory.occurrenceCount,
    }).from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount))
      .limit(5).catch(() => []),

    db.select({
      description:   successfulFixes.fixDescription,
      appliedCount:  successfulFixes.successCount,
    }).from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .orderBy(desc(successfulFixes.successCount))
      .limit(5).catch(() => []),

    db.select({
      provider: imageGenerations.provider,
      spendUsd: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      count:    sql<number>`count(*)::int`,
    }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, dayAgo)))
      .groupBy(imageGenerations.provider).catch(() => []),

    db.select({
      summary:    researchFindings.summary,
      sourceUrl:  researchFindings.sourceUrl,
      confidence: researchFindings.confidence,
    }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), gte(researchFindings.createdAt, dayAgo)))
      .orderBy(desc(researchFindings.confidence))
      .limit(5).catch(() => []),

    db.select({ title: incidents.title, severity: incidents.severity }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .orderBy(desc(incidents.detectedAt))
      .limit(5).catch(() => []),

    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(eq(auditFindings.workspaceId, workspaceId))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({
      id: patchApprovals.id, reason: patchApprovals.riskReason, createdAt: patchApprovals.createdAt,
    }).from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))
      .orderBy(desc(patchApprovals.createdAt))
      .limit(5).catch(() => []),

    db.select({
      title:         roadmapTasks.title,
      category:      roadmapTasks.category,
      priorityScore: roadmapTasks.priorityScore,
      phase:         roadmapTasks.phase,
    }).from(roadmapTasks)
      .where(and(eq(roadmapTasks.workspaceId, workspaceId), eq(roadmapTasks.status, 'pending')))
      .orderBy(desc(roadmapTasks.priorityScore))
      .limit(5).catch(() => []),

    db.select().from(providerBudgets)
      .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[daily-review]', e.message); return null }),

    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({ c: sql<number>`count(*)::int` }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, 'failed'), gte(workflowRuns.failedAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({
      active: sql<number>`count(*) filter (where ${strategicGoals.status} = 'active')::int`,
      avgProgress: sql<number>`coalesce(avg(${strategicGoals.progress}) filter (where ${strategicGoals.status} = 'active'), 0)::float`,
      completedToday: sql<number>`count(*) filter (where ${strategicGoals.status} = 'completed' AND ${strategicGoals.completedAt} >= ${dayAgo})::int`,
    }).from(strategicGoals)
      .where(eq(strategicGoals.workspaceId, workspaceId))
      .then(r => r[0] ?? { active: 0, avgProgress: 0, completedToday: 0 }).catch(() => ({ active: 0, avgProgress: 0, completedToday: 0 })),
  ])

  const next: string[] = []
  if (openIncidents.length > 0) next.push(`resolve ${openIncidents.length} open incident(s) before new autonomous actions`)
  if (failures.length > 0 && Number(failures[0]?.occurrences ?? 0) >= 3) {
    next.push(`address recurring failure: ${String(failures[0]?.signature).slice(0, 80)}`)
  }
  if (audit > 50) next.push(`${audit} audit findings — triage and resolve top 5`)
  if (insights.length > 0) next.push('review new research insights in War Room')
  if (next.length === 0) next.push('all green — keep monitoring')

  return {
    workspaceId,
    windowStart: dayAgo, windowEnd: now,
    topFailures: failures.map(f => ({ signature: String(f.signature ?? ''), occurrences: Number(f.occurrences ?? 0) })),
    topWins:     wins.map(w => ({ description: String(w.description ?? ''), appliedCount: Number(w.appliedCount ?? 0) })),
    topCosts:    imageSpend.map(s => ({ provider: String(s.provider), spendUsd: Number(s.spendUsd), count: Number(s.count) })),
    topInsights: insights.map(i => ({ summary: String(i.summary ?? '').slice(0, 200), sourceUrl: String(i.sourceUrl), confidence: Number(i.confidence) })),
    topBlockers: openIncidents.map(i => ({ title: String(i.title ?? ''), severity: String(i.severity ?? '') })),
    pendingApprovals: pending.map(p => ({ id: String(p.id), reason: String(p.reason ?? ''), createdAt: Number(p.createdAt ?? 0) })),
    topPriorities: priorities.map(p => ({
      title: String(p.title ?? ''), category: String(p.category ?? ''),
      priorityScore: Number(p.priorityScore ?? 0), phase: String(p.phase ?? ''),
    })),
    providerHealth: await snapshotProviderHealth(),
    budgetUsage: budgetRow ? {
      dailyPct:   budgetRow.dailyLimitUsd   > 0 ? Number((budgetRow.dailySpendUsd   / budgetRow.dailyLimitUsd  ).toFixed(3)) : 0,
      monthlyPct: budgetRow.monthlyLimitUsd > 0 ? Number((budgetRow.monthlySpendUsd / budgetRow.monthlyLimitUsd).toFixed(3)) : 0,
      alertThreshold: Number(budgetRow.alertThreshold),
    } : null,
    rollbackEvents:  rollbackCount,
    failedWorkflows: failedWorkflowCount,
    securityFindings,
    missionProgress: {
      active: Number(missionAgg.active ?? 0),
      avgProgress: Number(Number(missionAgg.avgProgress ?? 0).toFixed(2)),
      completedToday: Number(missionAgg.completedToday ?? 0),
    },
    nextRecommended: next,
  }
}

async function snapshotProviderHealth() {
  const { validateProviders, isResearchEnabled, isImageGenerationEnabled } = await import('./provider-validation.js')
  const probe = await validateProviders('default').catch(() => ({ results: [], configuredCount: 0, reachableCount: 0 }))
  const connected    = probe.results.filter(r => r.status === 'healthy').length
  const degraded     = probe.results.filter(r => r.status === 'degraded' || r.status === 'down').length
  const unconfigured = probe.results.filter(r => r.status === 'unconfigured').length
  return {
    connected, degraded, unconfigured,
    flags: { researchEnabled: isResearchEnabled(), imageGenerationEnabled: isImageGenerationEnabled() },
  }
}

export async function runDailyReview(workspaceId: string, opts?: { force?: boolean }): Promise<DailyReview | null> {
  if (!opts?.force && await alreadyEmittedToday(workspaceId)) return null
  const review = await generateDailyReview(workspaceId)
  await db.insert(events).values({
    id: uuidv7(), type: 'daily.review', workspaceId,
    payload: review as unknown as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'daily-review', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[daily-review]', e.message); return null })
  return review
}
