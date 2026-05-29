/**
 * home-dashboard.ts — Tier-5: unified landing payload.
 *
 * One endpoint that surfaces "what changed since I was last here / what
 * needs my attention" — replaces the operator scanning 15 pages.
 *
 * Aggregates: runtime liveness, open drift warnings, pending code
 * proposals, recent autonomous-mind decisions, calibration status,
 * active strategic horizons, top economic alerts.
 */
import { db } from '../db/client.js'
import {
  driftWarnings, codeProposals, reasoningChains,
  strategicHorizons, providerPreferences, recommendationFeedback,
  events, aiUsage, budgetCaps,
} from '../db/schema.js'
import { and, eq, desc, gte, sql, like, or } from 'drizzle-orm'
import { getRuntimeStatus } from './runtime-heartbeat.js'
import { learningCronHandleCount } from './learning-cron.js'

export async function homeDashboard(workspaceId: string) {
  const since24h = Date.now() - 24 * 60 * 60_000
  const runtime = getRuntimeStatus()
  const cronCount = learningCronHandleCount()

  // R146.16 — wire the new observability signals from R146.9-R146.15 into
  // the unified dashboard payload. Without this, every fix from the last
  // session is invisible to the operator: ai_usage now writes per chat
  // turn but no view shows the spend; budget caps now log when they
  // under-count but the dashboard reads only their static config; cron
  // tagging now emits `cron.<task>_workspace_failed` events but they
  // sit in the events table unseen. This block surfaces all of it.
  const [
    openDrift, pendingProposals, recentMind, activeHorizons,
    pendingPrefs, recentRejections, recentEvents,
    spendRows, capsRows, cronFailures, persistFailures,
  ] = await Promise.all([
    db.select({ id: driftWarnings.id, severity: driftWarnings.severity, kind: driftWarnings.kind })
      .from(driftWarnings)
      .where(and(eq(driftWarnings.workspaceId, workspaceId), eq(driftWarnings.status, 'open')))
      .limit(20).catch(() => []),
    db.select().from(codeProposals)
      .where(and(eq(codeProposals.workspaceId, workspaceId), eq(codeProposals.status, 'proposed')))
      .orderBy(desc(codeProposals.createdAt)).limit(10).catch(() => []),
    db.select({ id: reasoningChains.id, decision: reasoningChains.decision, createdAt: reasoningChains.createdAt })
      .from(reasoningChains)
      .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.source, 'autonomous-mind')))
      .orderBy(desc(reasoningChains.createdAt)).limit(10).catch(() => []),
    db.select({ id: strategicHorizons.id, title: strategicHorizons.title, horizon: strategicHorizons.horizon })
      .from(strategicHorizons)
      .where(and(eq(strategicHorizons.workspaceId, workspaceId), eq(strategicHorizons.status, 'active')))
      .limit(10).catch(() => []),
    db.select().from(providerPreferences)
      .where(and(eq(providerPreferences.workspaceId, workspaceId), eq(providerPreferences.status, 'pending')))
      .limit(10).catch(() => []),
    db.select({ n: sql<number>`count(*)::int` }).from(recommendationFeedback)
      .where(and(
        eq(recommendationFeedback.workspaceId, workspaceId),
        eq(recommendationFeedback.action, 'reject'),
        gte(recommendationFeedback.createdAt, since24h),
      )).then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
    db.select({ type: events.type, createdAt: events.createdAt })
      .from(events)
      .where(and(eq(events.workspaceId, 'global'), gte(events.createdAt, since24h)))
      .orderBy(desc(events.createdAt)).limit(20).catch(() => []),
    // ai_usage spend last 24h, grouped by task_type
    db.select({
        taskType: aiUsage.taskType,
        totalCost: sql<number>`coalesce(sum(${aiUsage.costUsd})::float, 0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsage.promptTokens} + ${aiUsage.outputTokens})::bigint, 0)`,
        calls: sql<number>`count(*)::int`,
      })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since24h)))
      .groupBy(aiUsage.taskType)
      .catch(() => []),
    // Budget caps with current spend
    db.select({
        scopeType: budgetCaps.scopeType,
        scopeId: budgetCaps.scopeId,
        maxDailyUsd: budgetCaps.maxDailyUsd,
        currentDailyUsd: budgetCaps.currentDailyUsd,
        maxMonthlyUsd: budgetCaps.maxMonthlyUsd,
        currentMonthlyUsd: budgetCaps.currentMonthlyUsd,
        enabled: budgetCaps.enabled,
      })
      .from(budgetCaps)
      .where(and(eq(budgetCaps.workspaceId, workspaceId), eq(budgetCaps.enabled, true)))
      .limit(20).catch(() => []),
    // Cron failure events last 24h (any `*_failed` or `cron.error` type)
    db.select({ type: events.type, createdAt: events.createdAt, payload: events.payload })
      .from(events)
      .where(and(
        or(eq(events.workspaceId, workspaceId), eq(events.workspaceId, 'global')),
        gte(events.createdAt, since24h),
        or(like(events.type, '%_failed'), like(events.type, 'cron.error%'), like(events.type, '%.workspace_failed')),
      ))
      .orderBy(desc(events.createdAt)).limit(10).catch(() => []),
    // Persistence-layer error count last 24h via `cron.error` payloads
    db.select({ n: sql<number>`count(*)::int` })
      .from(events)
      .where(and(
        or(eq(events.workspaceId, workspaceId), eq(events.workspaceId, 'global')),
        gte(events.createdAt, since24h),
        eq(events.type, 'cron.error'),
      ))
      .then(r => Number(r[0]?.n ?? 0)).catch(() => 0),
  ])

  // Attention score: higher = more operator attention needed
  const attentionItems: Array<{ kind: string; severity: 'low' | 'medium' | 'high' | 'critical'; text: string; ref?: string }> = []
  for (const d of openDrift.slice(0, 5)) {
    attentionItems.push({
      kind: 'drift_warning',
      severity: (d.severity as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
      text: `Drift: ${d.kind}`, ref: d.id,
    })
  }
  for (const p of pendingProposals.slice(0, 5)) {
    attentionItems.push({
      kind: 'code_proposal',
      severity: (p.riskLevel as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
      text: p.title, ref: p.id,
    })
  }
  for (const pref of pendingPrefs.slice(0, 3)) {
    attentionItems.push({
      kind: 'provider_preference',
      severity: 'medium',
      text: `Provider swap pending: ${pref.taskType} → ${pref.preferredProvider}`,
      ref: pref.taskType,
    })
  }
  if (runtime.lastHeartbeatAgoMs > 5 * 60_000) {
    attentionItems.push({
      kind: 'runtime_stale',
      severity: 'critical',
      text: `Runtime heartbeat stale (${Math.floor(runtime.lastHeartbeatAgoMs / 1000)}s)`,
    })
  }
  // R146.16 — surface budget caps approaching their limit
  for (const cap of capsRows) {
    const dailyPct = cap.maxDailyUsd > 0 ? cap.currentDailyUsd / cap.maxDailyUsd : 0
    const monthlyPct = cap.maxMonthlyUsd > 0 ? cap.currentMonthlyUsd / cap.maxMonthlyUsd : 0
    if (dailyPct >= 0.9) {
      attentionItems.push({
        kind: 'budget_near_cap',
        severity: dailyPct >= 1.0 ? 'critical' : 'high',
        text: `${cap.scopeType}/${cap.scopeId} at ${(dailyPct * 100).toFixed(0)}% of daily cap ($${cap.currentDailyUsd.toFixed(2)} / $${cap.maxDailyUsd.toFixed(2)})`,
      })
    } else if (monthlyPct >= 0.9) {
      attentionItems.push({
        kind: 'budget_near_cap',
        severity: monthlyPct >= 1.0 ? 'critical' : 'high',
        text: `${cap.scopeType}/${cap.scopeId} at ${(monthlyPct * 100).toFixed(0)}% of monthly cap ($${cap.currentMonthlyUsd.toFixed(2)} / $${cap.maxMonthlyUsd.toFixed(2)})`,
      })
    }
  }
  // Surface cron failures from the last 24h
  for (const f of cronFailures.slice(0, 5)) {
    attentionItems.push({
      kind: 'cron_failure',
      severity: 'medium',
      text: `${f.type} — ${new Date(f.createdAt).toISOString().slice(11, 19)}Z`,
    })
  }
  if (persistFailures > 0) {
    attentionItems.push({
      kind: 'persistence_errors',
      severity: persistFailures > 10 ? 'high' : 'medium',
      text: `${persistFailures} cron-layer errors in last 24h`,
    })
  }
  // Compute total spend + top task types
  const totalCostUsd = spendRows.reduce((a, r) => a + Number(r.totalCost ?? 0), 0)
  const totalTokens  = spendRows.reduce((a, r) => a + Number(r.totalTokens ?? 0), 0)
  const totalCalls   = spendRows.reduce((a, r) => a + Number(r.calls ?? 0), 0)
  const spendByTaskType = [...spendRows]
    .map(r => ({
      taskType: r.taskType,
      costUsd:  Number(Number(r.totalCost ?? 0).toFixed(6)),
      tokens:   Number(r.totalTokens ?? 0),
      calls:    Number(r.calls ?? 0),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)

  return {
    generatedAt: Date.now(),
    runtime: {
      liveness: runtime.lastHeartbeatAgoMs < 120_000 ? 'live' : 'stale',
      uptimeHuman: runtime.uptimeHuman,
      cronCount,
      memoryMb: runtime.memoryMb,
    },
    attentionItems,
    counts: {
      openDriftWarnings: openDrift.length,
      pendingProposals:  pendingProposals.length,
      pendingPrefs:      pendingPrefs.length,
      activeHorizons:    activeHorizons.length,
      recentRejections24h: recentRejections,
      cronFailures24h:   cronFailures.length,
      persistFailures24h: persistFailures,
    },
    // R146.16 — observability bundle from the previous session's fixes
    spend24h: {
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalTokens,
      totalCalls,
      byTaskType: spendByTaskType,
    },
    budgetCaps: capsRows.map(c => ({
      scope: `${c.scopeType}/${c.scopeId}`,
      dailyUsd:   { current: Number(c.currentDailyUsd.toFixed(4)),   max: Number(c.maxDailyUsd.toFixed(2)) },
      monthlyUsd: { current: Number(c.currentMonthlyUsd.toFixed(4)), max: Number(c.maxMonthlyUsd.toFixed(2)) },
      dailyPct:   c.maxDailyUsd   > 0 ? Number((c.currentDailyUsd   / c.maxDailyUsd  * 100).toFixed(1)) : null,
      monthlyPct: c.maxMonthlyUsd > 0 ? Number((c.currentMonthlyUsd / c.maxMonthlyUsd * 100).toFixed(1)) : null,
    })),
    cronFailures24h: cronFailures,
    activeHorizons,
    recentMindDecisions: recentMind,
    recentEvents,
    notes: [
      attentionItems.length === 0 ? 'No items currently need operator attention.' : `${attentionItems.length} items need attention.`,
      pendingProposals.length > 0 ? `${pendingProposals.length} code proposals awaiting review.` : null,
      cronCount < 22 ? `Only ${cronCount} crons active (expected ≥22) — heartbeat will re-arm.` : `${cronCount} crons active.`,
      totalCalls > 0 ? `LLM spend 24h: $${totalCostUsd.toFixed(4)} across ${totalCalls} calls (${totalTokens.toLocaleString()} tokens)` : 'No LLM activity in last 24h.',
    ].filter(Boolean) as string[],
  }
}
