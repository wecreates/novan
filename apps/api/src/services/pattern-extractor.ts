/**
 * pattern-extractor.ts — Turn high-frequency real signals into reusable
 * preventive recommendations + reusable strategies + skill candidates.
 *
 * Writes to existing roadmap_tasks (preventive recs) — uses approval
 * gating from prior turns.
 */
import { db }                          from '../db/client.js'
import {
  failureMemory, successfulFixes, feedbackReports, providerHealthLog,
  auditFindings, roadmapTasks, events, telemetryEvents,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

const WEEK = 7 * 24 * 60 * 60_000

export interface PatternExtractionResult {
  workspaceId:              string
  recurringBottlenecks:     number
  recurringOperatorPain:    number
  recurringProviderFailures: number
  recurringSecurityRisks:   number
  preventiveRecsCreated:    number
  reusableStrategies:       number
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'pattern-extractor', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[pattern-extractor]', e.message); return null })
}

/** Create a preventive roadmap task if not already present for the source pattern. */
async function ensurePreventiveTask(workspaceId: string, recoId: string, opts: {
  title: string
  description: string
  category: string
  impact: number
  risk: number
  requiresApproval: boolean
}): Promise<boolean> {
  const existing = await db.select({ id: roadmapTasks.id }).from(roadmapTasks)
    .where(and(eq(roadmapTasks.workspaceId, workspaceId), eq(roadmapTasks.recommendationId, recoId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[pattern-extractor]', e.message); return null })
  if (existing) return false
  const now = Date.now()
  await db.insert(roadmapTasks).values({
    id: uuidv7(), workspaceId, recommendationId: recoId,
    phase: 'near_term', title: opts.title, description: opts.description,
    category: opts.category, impact: opts.impact, risk: opts.risk,
    priorityScore: Math.round(opts.impact * 20 - opts.risk * 5 + 30),
    requiresApproval: opts.requiresApproval, status: 'pending',
    createdAt: now, updatedAt: now,
  }).onConflictDoNothing().catch((e: Error) => { console.error('[pattern-extractor]', e.message); return null })
  return true
}

export async function extractPatterns(workspaceId: string): Promise<PatternExtractionResult> {
  const { recordAgentActivityAsync } = await import('./agent-state-sync.js')
  recordAgentActivityAsync(workspaceId, 'trend_detection', { status: 'running' })
  const result: PatternExtractionResult = {
    workspaceId,
    recurringBottlenecks: 0, recurringOperatorPain: 0,
    recurringProviderFailures: 0, recurringSecurityRisks: 0,
    preventiveRecsCreated: 0, reusableStrategies: 0,
  }

  // ── 1. Recurring bottlenecks (failure_memory ≥5 occurrences) ───────────
  const bottlenecks = await db.select().from(failureMemory)
    .where(and(eq(failureMemory.workspaceId, workspaceId), sql`${failureMemory.occurrenceCount} >= 5`))
    .orderBy(desc(failureMemory.occurrenceCount)).catch(() => [])
  for (const b of bottlenecks) {
    result.recurringBottlenecks++
    const created = await ensurePreventiveTask(workspaceId, `pattern:bottleneck:${b.id}`, {
      title: `Prevent recurring failure: ${String(b.signature).slice(0, 100)}`,
      description: `Failure occurred ${b.occurrenceCount}× (type: ${b.failureType}). Investigate root cause and add preventive guard.`,
      category: 'reliability', impact: 4, risk: 2,
      requiresApproval: false,
    })
    if (created) result.preventiveRecsCreated++
  }

  // ── 2. Recurring operator pain (≥3 same-kind feedback in 30d) ───────────
  const thirtyDays = Date.now() - 30 * 24 * 60 * 60_000
  const painCounts = await db.select({
    kind: feedbackReports.kind, c: sql<number>`count(*)::int`,
  }).from(feedbackReports)
    .where(and(eq(feedbackReports.workspaceId, workspaceId), gte(feedbackReports.createdAt, thirtyDays), eq(feedbackReports.kind, 'issue')))
    .groupBy(feedbackReports.kind).catch(() => [])
  for (const p of painCounts) {
    const n = Number(p.c)
    if (n < 3) continue
    result.recurringOperatorPain++
    const created = await ensurePreventiveTask(workspaceId, `pattern:operator_pain:${p.kind}`, {
      title: `Address recurring operator pain (${n} reports)`,
      description: `${n} operator-reported issues of kind '${p.kind}' in the last 30 days.`,
      category: 'ux', impact: 3, risk: 1,
      requiresApproval: false,
    })
    if (created) result.preventiveRecsCreated++
  }

  // ── 3. Recurring provider failures (≥10 'degraded'+'down' in 7d) ────────
  const providerFail = await db.select({
    provider: providerHealthLog.providerId,
    failures: sql<number>`count(*) filter (where ${providerHealthLog.status} in ('degraded','down'))::int`,
  }).from(providerHealthLog)
    .where(and(eq(providerHealthLog.workspaceId, workspaceId), gte(providerHealthLog.checkedAt, Date.now() - WEEK)))
    .groupBy(providerHealthLog.providerId).catch(() => [])
  for (const p of providerFail) {
    const n = Number(p.failures)
    if (n < 10) continue
    result.recurringProviderFailures++
    const created = await ensurePreventiveTask(workspaceId, `pattern:provider_failure:${p.provider}`, {
      title: `Provider ${p.provider} unstable (${n} bad probes / 7d)`,
      description: `${n} degraded-or-down probes for ${p.provider} in 7 days. Consider failover or alternate provider.`,
      category: 'reliability', impact: 4, risk: 2,
      requiresApproval: false,
    })
    if (created) result.preventiveRecsCreated++
  }

  // ── 4. Recurring security risks (audit findings clustered by category) ─
  const sec = await db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
    .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  if (sec >= 5) {
    result.recurringSecurityRisks++
    const created = await ensurePreventiveTask(workspaceId, `pattern:security_cluster`, {
      title: `Cluster of ${sec} security audit findings`,
      description: 'Multiple security findings outstanding — schedule security review and triage by severity.',
      category: 'security', impact: 5, risk: 3,
      requiresApproval: true,
    })
    if (created) result.preventiveRecsCreated++
  }

  // ── 5. Reusable strategies (proven fix patterns ≥3 success → strategy) ─
  const strats = await db.select().from(successfulFixes)
    .where(and(eq(successfulFixes.workspaceId, workspaceId), sql`${successfulFixes.successCount} >= 3`))
    .catch(() => [])
  for (const s of strats) {
    result.reusableStrategies++
    void s
    // Strategy is implicit in the compressed_lessons fix_pattern row;
    // we just count here. The skill-gap detector can later promote this
    // to a runnable skill.
  }

  await emit(workspaceId, 'patterns_extracted', result as unknown as Record<string, unknown>)
  return result
}
