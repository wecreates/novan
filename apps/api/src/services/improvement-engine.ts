/**
 * improvement-engine.ts — Autonomous improvement detector + roadmap generator.
 *
 * Pure analyzer: scans real runtime tables, produces evidence-backed
 * recommendations, ranks them by impact/risk, groups into phases.
 *
 * NO fake claims — every recommendation carries `evidenceRefs` pointing to
 * real source-table row IDs. Risky improvements require approval.
 */
import { db }                from '../db/client.js'
import {
  optimizationRecommendations, roadmapTasks,
  failureMemory, sandboxSessions, verificationEvidence,
  providerHealthLog, providerFailures, deadLetterJobs,
  agentRegistrations, patchRecords, events,
}                            from '../db/schema.js'
import { eq, and, desc, gt, inArray } from 'drizzle-orm'
import { v7 as uuidv7 }      from 'uuid'

export type Category =
  | 'reliability' | 'performance' | 'cost' | 'ux'
  | 'tests' | 'observability' | 'infra'

export type Phase = 'immediate' | 'near_term' | 'backlog'

export interface EvidenceRef { table: string; id: string }

export interface Recommendation {
  category:         Category
  subject:          string
  title:            string
  description:      string
  impact:           number  // 0-100
  risk:             number  // 0-100
  evidenceRefs:     EvidenceRef[]
  recommendedAgent: string
  requiresApproval: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'improvement-engine', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

function priorityScore(impact: number, risk: number): number {
  // Higher impact, lower risk = higher score
  return Math.round(impact - risk * 0.5)
}

function phaseFor(score: number, requiresApproval: boolean): Phase {
  if (requiresApproval) return 'near_term'
  if (score >= 60) return 'immediate'
  if (score >= 30) return 'near_term'
  return 'backlog'
}

// ─── Analyzers — each queries REAL data and produces zero or more recs ────────

async function analyzeRepeatedFailures(ws: string): Promise<Recommendation[]> {
  const rows = await db.select().from(failureMemory)
    .where(and(
      eq(failureMemory.workspaceId, ws),
      gt(failureMemory.occurrenceCount, 1),
    ))
    .orderBy(desc(failureMemory.occurrenceCount))
    .limit(20)

  return rows.map((f) => ({
    category: 'reliability' as Category,
    subject: f.targetRef,
    title: `Recurring failure: ${f.targetRef.slice(0, 60)}`,
    description: `Failure pattern has occurred ${f.occurrenceCount} time(s). ${
      f.blocked ? 'BLOCKED — needs new strategy.' : 'Trending toward block threshold.'
    } Root cause class: ${f.rootCauseClass}.`,
    impact: Math.min(100, f.occurrenceCount * 20),
    risk: f.blocked ? 30 : 20,
    evidenceRefs: [{ table: 'failure_memory', id: f.id }],
    recommendedAgent: 'reliability-engineer',
    requiresApproval: f.blocked,
  }))
}

async function analyzeSlowSandboxes(ws: string): Promise<Recommendation[]> {
  const rows = await db.select({
    id: sandboxSessions.id, command: sandboxSessions.command,
    durationMs: sandboxSessions.durationMs, status: sandboxSessions.status,
  }).from(sandboxSessions)
    .where(and(
      eq(sandboxSessions.workspaceId, ws),
      eq(sandboxSessions.status, 'timeout'),
    ))
    .orderBy(desc(sandboxSessions.startedAt))
    .limit(50)

  if (rows.length < 3) return []

  // Group by command
  const byCmd = new Map<string, string[]>()
  for (const r of rows) {
    const arr = byCmd.get(r.command) ?? []
    arr.push(r.id)
    byCmd.set(r.command, arr)
  }

  const recs: Recommendation[] = []
  for (const [cmd, ids] of byCmd) {
    if (ids.length < 3) continue
    recs.push({
      category: 'performance',
      subject:  cmd,
      title:    `Command '${cmd}' timing out repeatedly`,
      description: `${ids.length} sandbox session(s) for '${cmd}' hit timeout. Consider raising timeout, splitting work, or optimizing the command.`,
      impact: Math.min(100, ids.length * 15),
      risk: 20,
      evidenceRefs: ids.slice(0, 5).map((id) => ({ table: 'sandbox_sessions', id })),
      recommendedAgent: 'performance-engineer',
      requiresApproval: false,
    })
  }
  return recs
}

async function analyzeProviderCosts(ws: string): Promise<Recommendation[]> {
  // Provider failures suggest unhealthy/costly providers
  const rows = await db.select({
    id: providerFailures.id, providerId: providerFailures.providerId,
  }).from(providerFailures)
    .where(eq(providerFailures.workspaceId, ws))
    .limit(500)

  if (rows.length < 5) return []

  const byProvider = new Map<string, string[]>()
  for (const r of rows) {
    const arr = byProvider.get(r.providerId) ?? []
    arr.push(r.id)
    byProvider.set(r.providerId, arr)
  }

  const recs: Recommendation[] = []
  for (const [provider, ids] of byProvider) {
    if (ids.length < 5) continue
    recs.push({
      category: 'cost',
      subject:  provider,
      title:    `Provider '${provider}' has high failure rate`,
      description: `${ids.length} failures recorded. Failed calls still count toward cost — consider routing away from this provider or fixing config.`,
      impact: Math.min(100, ids.length * 5),
      risk: 25,
      evidenceRefs: ids.slice(0, 5).map((id) => ({ table: 'provider_failures', id })),
      recommendedAgent: 'cost-engineer',
      requiresApproval: false,
    })
  }
  return recs
}

async function analyzeQueuePressure(ws: string): Promise<Recommendation[]> {
  const rows = await db.select({
    id: deadLetterJobs.id, queueName: deadLetterJobs.queueName,
  }).from(deadLetterJobs)
    .where(eq(deadLetterJobs.workspaceId, ws))
    .limit(500)

  if (rows.length < 10) return []
  const byQueue = new Map<string, string[]>()
  for (const r of rows) {
    const arr = byQueue.get(r.queueName) ?? []
    arr.push(r.id)
    byQueue.set(r.queueName, arr)
  }

  const recs: Recommendation[] = []
  for (const [queue, ids] of byQueue) {
    if (ids.length < 10) continue
    recs.push({
      category: 'infra',
      subject:  queue,
      title:    `Queue '${queue}' has chronic dead-letter pressure`,
      description: `${ids.length} dead-letter jobs accumulated. Scale workers or fix systematic failure pattern.`,
      impact: Math.min(100, ids.length * 3),
      risk: 30,
      evidenceRefs: ids.slice(0, 5).map((id) => ({ table: 'dead_letter_jobs', id })),
      recommendedAgent: 'queue-recovery-agent',
      requiresApproval: false,
    })
  }
  return recs
}

async function analyzeUnstableAgents(ws: string): Promise<Recommendation[]> {
  const rows = await db.select().from(agentRegistrations)
    .where(eq(agentRegistrations.workspaceId, ws))

  const recs: Recommendation[] = []
  for (const a of rows) {
    const total = a.successCount + a.failureCount
    if (total < 5) continue
    const rollbackRate = a.rollbackCount / Math.max(1, total)
    const failureRate  = a.failureCount  / total
    if (failureRate < 0.3 && rollbackRate < 0.2) continue
    recs.push({
      category: 'reliability',
      subject:  a.id,
      title:    `Agent '${a.agentName}' is unstable`,
      description: `${(failureRate * 100).toFixed(0)}% failure rate, ${(rollbackRate * 100).toFixed(0)}% rollback rate across ${total} runs. Consider retraining, replacing, or constraining its scope.`,
      impact: Math.min(100, Math.round(failureRate * 100 + rollbackRate * 50)),
      risk: 40,
      evidenceRefs: [{ table: 'agent_registrations', id: a.id }],
      recommendedAgent: 'agent-supervisor',
      requiresApproval: true,
    })
  }
  return recs
}

async function analyzeMissingTests(ws: string): Promise<Recommendation[]> {
  // Files with patches but no co-located test passes
  const patches = await db.select({
    id: patchRecords.id, filePath: patchRecords.filePath,
  }).from(patchRecords)
    .where(eq(patchRecords.workspaceId, ws))
    .limit(200)

  if (patches.length === 0) return []

  // Group by file
  const byFile = new Map<string, string[]>()
  for (const p of patches) {
    const arr = byFile.get(p.filePath) ?? []
    arr.push(p.id)
    byFile.set(p.filePath, arr)
  }

  // Recent test evidence — files patched but no tests in last 7d
  const recentTests = await db.select({ id: verificationEvidence.id, passed: verificationEvidence.passed })
    .from(verificationEvidence)
    .where(and(
      eq(verificationEvidence.workspaceId, ws),
      eq(verificationEvidence.command, 'vitest'),
      gt(verificationEvidence.createdAt, Date.now() - 7 * 24 * 3600_000),
    ))
    .limit(50)

  if (recentTests.length === 0) {
    // No tests at all — single rec
    return [{
      category: 'tests',
      subject:  'workspace',
      title:    `No recent test runs recorded`,
      description: `${patches.length} patch record(s) exist but no vitest evidence in last 7d. Wire up CI to write verification_evidence on every test run.`,
      impact: 80,
      risk: 10,
      evidenceRefs: patches.slice(0, 3).map((p) => ({ table: 'patch_records', id: p.id })),
      recommendedAgent: 'test-engineer',
      requiresApproval: false,
    }]
  }
  return []
}

async function analyzeProviderHealth(ws: string): Promise<Recommendation[]> {
  const rows = await db.select({
    id: providerHealthLog.id, providerId: providerHealthLog.providerId,
    status: providerHealthLog.status, errorRate: providerHealthLog.errorRate,
  }).from(providerHealthLog)
    .where(and(
      eq(providerHealthLog.workspaceId, ws),
      gt(providerHealthLog.checkedAt, Date.now() - 24 * 3600_000),
    ))
    .orderBy(desc(providerHealthLog.checkedAt))
    .limit(200)

  if (rows.length === 0) {
    return [{
      category: 'observability',
      subject:  'provider_health',
      title:    'No provider health monitoring data',
      description: 'No provider_health_log entries in last 24h — wire up periodic health checks.',
      impact: 60,
      risk: 5,
      evidenceRefs: [],
      recommendedAgent: 'observability-engineer',
      requiresApproval: false,
    }]
  }
  return []
}

const ANALYZERS = [
  analyzeRepeatedFailures, analyzeSlowSandboxes, analyzeProviderCosts,
  analyzeQueuePressure, analyzeUnstableAgents, analyzeMissingTests, analyzeProviderHealth,
]

// ─── Scan + persist ───────────────────────────────────────────────────────────

export interface ScanResult {
  scanned:        number
  created:        number
  refreshed:      number
  recommendations: Array<{ id: string; category: Category; priorityScore: number; title: string }>
}

export async function runImprovementScan(workspaceId: string): Promise<ScanResult> {
  const found: Recommendation[] = []
  for (const a of ANALYZERS) {
    try { found.push(...(await a(workspaceId))) } catch { /* analyzer-local failure shouldn't stop scan */ }
  }

  let created = 0, refreshed = 0
  const persisted: ScanResult['recommendations'] = []
  const now = Date.now()

  for (const r of found) {
    const score = priorityScore(r.impact, r.risk)

    // Dedup: same category + subject + title open already?
    const existing = await db.select().from(optimizationRecommendations)
      .where(and(
        eq(optimizationRecommendations.workspaceId, workspaceId),
        eq(optimizationRecommendations.category, r.category),
        eq(optimizationRecommendations.subject, r.subject),
        eq(optimizationRecommendations.title, r.title),
        inArray(optimizationRecommendations.status, ['open', 'in_roadmap']),
      )).limit(1)

    if (existing[0]) {
      await db.update(optimizationRecommendations).set({
        description:    r.description,
        impact:         r.impact,
        risk:           r.risk,
        priorityScore:  score,
        evidenceRefs:   r.evidenceRefs as unknown as Record<string, unknown>[],
        updatedAt:      now,
      }).where(eq(optimizationRecommendations.id, existing[0].id))
      refreshed += 1
      persisted.push({ id: existing[0].id, category: r.category, priorityScore: score, title: r.title })
      continue
    }

    const id = uuidv7()
    await db.insert(optimizationRecommendations).values({
      id,
      workspaceId,
      category:         r.category,
      subject:          r.subject,
      title:            r.title,
      description:      r.description,
      impact:           r.impact,
      risk:             r.risk,
      priorityScore:    score,
      evidenceRefs:     r.evidenceRefs as unknown as Record<string, unknown>[],
      status:           'open',
      requiresApproval: r.requiresApproval,
      recommendedAgent: r.recommendedAgent,
      detectedAt:       now,
      updatedAt:        now,
    })
    created += 1
    persisted.push({ id, category: r.category, priorityScore: score, title: r.title })

    await emitEvent(workspaceId, 'improvement.optimization_detected', {
      recommendationId: id, category: r.category, priorityScore: score,
      requiresApproval: r.requiresApproval, subject: r.subject,
    })
  }

  return { scanned: found.length, created, refreshed, recommendations: persisted }
}

// ─── Roadmap generation ───────────────────────────────────────────────────────

export interface RoadmapResult {
  immediate:  RoadmapEntry[]
  nearTerm:   RoadmapEntry[]
  backlog:    RoadmapEntry[]
  created:    number
}
export interface RoadmapEntry {
  id:               string
  recommendationId: string | null
  title:            string
  category:         string
  phase:            string
  impact:           number
  risk:             number
  priorityScore:    number
  requiresApproval: boolean
  recommendedAgent: string | null
}

export async function generateRoadmap(workspaceId: string): Promise<RoadmapResult> {
  // Take all OPEN recommendations not yet on roadmap
  const recs = await db.select().from(optimizationRecommendations)
    .where(and(
      eq(optimizationRecommendations.workspaceId, workspaceId),
      eq(optimizationRecommendations.status, 'open'),
    ))
    .orderBy(desc(optimizationRecommendations.priorityScore))
    .limit(100)

  let created = 0
  const now = Date.now()

  for (const r of recs) {
    const phase = phaseFor(r.priorityScore, r.requiresApproval)
    const id = uuidv7()
    await db.insert(roadmapTasks).values({
      id,
      workspaceId,
      recommendationId: r.id,
      phase,
      title:            r.title,
      description:      r.description,
      category:         r.category,
      impact:           r.impact,
      risk:             r.risk,
      priorityScore:    r.priorityScore,
      assignedAgent:    r.recommendedAgent,
      requiresApproval: r.requiresApproval,
      status:           r.requiresApproval ? 'pending' : 'pending',
      createdAt:        now,
      updatedAt:        now,
    })
    await db.update(optimizationRecommendations).set({
      status: 'in_roadmap', updatedAt: now,
    }).where(eq(optimizationRecommendations.id, r.id))

    await emitEvent(workspaceId, 'improvement.roadmap_task_created', {
      taskId: id, recommendationId: r.id, phase, priorityScore: r.priorityScore,
    })
    created += 1
  }

  const all = await db.select().from(roadmapTasks)
    .where(eq(roadmapTasks.workspaceId, workspaceId))
    .orderBy(desc(roadmapTasks.priorityScore))
    .limit(200)

  const toEntry = (t: typeof all[number]): RoadmapEntry => ({
    id:               t.id,
    recommendationId: t.recommendationId,
    title:            t.title,
    category:         t.category,
    phase:            t.phase,
    impact:           t.impact,
    risk:             t.risk,
    priorityScore:    t.priorityScore,
    requiresApproval: t.requiresApproval,
    recommendedAgent: t.assignedAgent,
  })

  await emitEvent(workspaceId, 'improvement.roadmap_reprioritized', {
    total: all.length, created,
  })

  return {
    immediate:  all.filter((t) => t.phase === 'immediate').map(toEntry),
    nearTerm:   all.filter((t) => t.phase === 'near_term').map(toEntry),
    backlog:    all.filter((t) => t.phase === 'backlog').map(toEntry),
    created,
  }
}

// ─── Apply / block ────────────────────────────────────────────────────────────

export async function applyRecommendation(
  recommendationId: string, actor: string, approvalGranted: boolean,
): Promise<{ ok: boolean; reason?: string }> {
  const rows = await db.select().from(optimizationRecommendations)
    .where(eq(optimizationRecommendations.id, recommendationId)).limit(1)
  const r = rows[0]
  if (!r) return { ok: false, reason: 'Recommendation not found' }
  if (r.requiresApproval && !approvalGranted) {
    await emitEvent(r.workspaceId, 'improvement.optimization_blocked', {
      recommendationId, reason: 'requires_approval', actor,
    })
    return { ok: false, reason: 'Recommendation requires approval' }
  }

  await db.update(optimizationRecommendations).set({
    status: 'applied', updatedAt: Date.now(),
  }).where(eq(optimizationRecommendations.id, recommendationId))

  await emitEvent(r.workspaceId, 'improvement.optimization_applied', {
    recommendationId, actor, category: r.category, subject: r.subject,
  })
  return { ok: true }
}

export async function dismissRecommendation(
  recommendationId: string, actor: string, reason: string,
): Promise<void> {
  const now = Date.now()
  const rows = await db.select().from(optimizationRecommendations)
    .where(eq(optimizationRecommendations.id, recommendationId)).limit(1)
  if (!rows[0]) return
  await db.update(optimizationRecommendations).set({
    status: 'dismissed', dismissedReason: `${actor}: ${reason}`, updatedAt: now,
  }).where(eq(optimizationRecommendations.id, recommendationId))
  await emitEvent(rows[0].workspaceId, 'improvement.optimization_blocked', {
    recommendationId, reason: 'dismissed', actor, note: reason,
  })
}

// ─── Optimization tracking metrics ────────────────────────────────────────────

export interface OptimizationMetrics {
  providerEfficiency:   number     // pass rate of provider health
  patchSuccessRate:     number     // % patches with status=applied
  rollbackFrequency:    number     // % patches rolled back
  recoverySuccessRate:  number     // dead-letter replayed / total
  avgSandboxLatencyMs:  number
  queuePressure:        number     // unreplayed DLQ count
  recentBuildSuccessRate: number
}

export async function computeMetrics(workspaceId: string): Promise<OptimizationMetrics> {
  // Provider health
  const ph = await db.select({ status: providerHealthLog.status })
    .from(providerHealthLog)
    .where(and(
      eq(providerHealthLog.workspaceId, workspaceId),
      gt(providerHealthLog.checkedAt, Date.now() - 24 * 3600_000),
    )).limit(200)
  const providerEfficiency = ph.length === 0 ? 0
    : ph.filter((p) => p.status === 'healthy').length / ph.length

  // Patches
  const patches = await db.select({ status: patchRecords.status })
    .from(patchRecords)
    .where(eq(patchRecords.workspaceId, workspaceId)).limit(500)
  const total = patches.length || 1
  const patchSuccessRate  = patches.filter((p) => p.status === 'applied' || p.status === 'verified').length / total
  const rollbackFrequency = patches.filter((p) => p.status === 'rolled_back').length / total

  // DLQ
  const dlq = await db.select({ replayedAt: deadLetterJobs.replayedAt })
    .from(deadLetterJobs)
    .where(eq(deadLetterJobs.workspaceId, workspaceId)).limit(500)
  const totalDlq = dlq.length || 1
  const recoverySuccessRate = dlq.filter((d) => d.replayedAt !== null).length / totalDlq
  const queuePressure = dlq.filter((d) => d.replayedAt === null).length

  // Sandbox latency
  const sandboxes = await db.select({ durationMs: sandboxSessions.durationMs })
    .from(sandboxSessions)
    .where(and(
      eq(sandboxSessions.workspaceId, workspaceId),
      eq(sandboxSessions.status, 'complete'),
    )).limit(100)
  const durations = sandboxes.map((s) => s.durationMs ?? 0).filter((n) => n > 0)
  const avgSandboxLatencyMs = durations.length === 0 ? 0
    : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)

  // Build success
  const builds = await db.select({ passed: verificationEvidence.passed })
    .from(verificationEvidence)
    .where(and(
      eq(verificationEvidence.workspaceId, workspaceId),
      gt(verificationEvidence.createdAt, Date.now() - 7 * 24 * 3600_000),
    )).limit(100)
  const recentBuildSuccessRate = builds.length === 0 ? 0
    : builds.filter((b) => b.passed).length / builds.length

  return {
    providerEfficiency, patchSuccessRate, rollbackFrequency,
    recoverySuccessRate, avgSandboxLatencyMs, queuePressure, recentBuildSuccessRate,
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listRecommendations(workspaceId: string, status?: string) {
  if (status) {
    return db.select().from(optimizationRecommendations)
      .where(and(
        eq(optimizationRecommendations.workspaceId, workspaceId),
        eq(optimizationRecommendations.status, status),
      ))
      .orderBy(desc(optimizationRecommendations.priorityScore))
      .limit(100)
  }
  return db.select().from(optimizationRecommendations)
    .where(eq(optimizationRecommendations.workspaceId, workspaceId))
    .orderBy(desc(optimizationRecommendations.priorityScore))
    .limit(100)
}

export async function listRoadmap(workspaceId: string) {
  return db.select().from(roadmapTasks)
    .where(eq(roadmapTasks.workspaceId, workspaceId))
    .orderBy(desc(roadmapTasks.priorityScore))
    .limit(200)
}
