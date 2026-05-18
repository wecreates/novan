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
  events,
} from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { getRuntimeStatus } from './runtime-heartbeat.js'
import { learningCronHandleCount } from './learning-cron.js'

export async function homeDashboard(workspaceId: string) {
  const since24h = Date.now() - 24 * 60 * 60_000
  const runtime = getRuntimeStatus()
  const cronCount = learningCronHandleCount()

  const [
    openDrift, pendingProposals, recentMind, activeHorizons,
    pendingPrefs, recentRejections, recentEvents,
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
    },
    activeHorizons,
    recentMindDecisions: recentMind,
    recentEvents,
    notes: [
      attentionItems.length === 0 ? 'No items currently need operator attention.' : `${attentionItems.length} items need attention.`,
      pendingProposals.length > 0 ? `${pendingProposals.length} code proposals awaiting review.` : null,
      cronCount < 22 ? `Only ${cronCount} crons active (expected ≥22) — heartbeat will re-arm.` : `${cronCount} crons active.`,
    ].filter(Boolean) as string[],
  }
}
