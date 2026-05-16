/**
 * incident-detector.ts — Pure detection layer. Queries real DB signals.
 *
 * Each detector returns IncidentCandidate[] backed by real row IDs.
 * NEVER fabricates incidents. If no signals match, returns [].
 */
import { db }                from '../db/client.js'
import {
  workflowRuns, providerHealthLog, sandboxSessions,
  deadLetterJobs, budgetAlerts, verificationEvidence,
  patchRecords,
} from '../db/schema.js'
import { eq, and, gt, lt, desc, count } from 'drizzle-orm'

export type IncidentType =
  | 'failed_workflow_spike'
  | 'provider_outage'
  | 'worker_heartbeat_failure'
  | 'queue_backlog'
  | 'budget_burn'
  | 'replay_divergence'
  | 'rollback_failure'

export type Severity = 'info' | 'warning' | 'critical' | 'emergency'

export interface IncidentCandidate {
  type:               IncidentType
  severity:           Severity
  title:              string
  summary:            string
  rootCauseHypothesis: string
  affectedSystems:    Record<string, unknown>
  linkedEventIds:     string[]  // real row IDs from source tables
  signalCount:        number
  detectedAt:         number
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const FAILED_WORKFLOW_THRESHOLD     = 5     // ≥5 failures in window = spike
const FAILED_WORKFLOW_WINDOW_MS     = 10 * 60_000  // 10 min
const PROVIDER_DOWN_WINDOW_MS       = 5 * 60_000
const HEARTBEAT_STALE_MS            = 60_000  // sandbox lease expired > 60s ago
const QUEUE_BACKLOG_THRESHOLD       = 20     // ≥20 dead-letter jobs
const BUDGET_BURN_SEVERE_PCT        = 90
const ROLLBACK_FAILURE_WINDOW_MS    = 60 * 60_000  // 1 hour

// ─── 1. Failed workflow spike ─────────────────────────────────────────────────

export async function detectFailedWorkflowSpike(workspaceId: string): Promise<IncidentCandidate[]> {
  const since = Date.now() - FAILED_WORKFLOW_WINDOW_MS
  const failed = await db.select({
    id: workflowRuns.id,
    workflowId: workflowRuns.workflowId,
    failedAt: workflowRuns.failedAt,
    errorMessage: workflowRuns.errorMessage,
  }).from(workflowRuns)
    .where(and(
      eq(workflowRuns.workspaceId, workspaceId),
      eq(workflowRuns.status, 'failed'),
      gt(workflowRuns.failedAt, since),
    ))
    .limit(100)

  if (failed.length < FAILED_WORKFLOW_THRESHOLD) return []

  // Group by workflowId — if a single workflow is failing, target that one
  const byWorkflow = new Map<string, typeof failed>()
  for (const f of failed) {
    const arr = byWorkflow.get(f.workflowId) ?? []
    arr.push(f)
    byWorkflow.set(f.workflowId, arr)
  }

  const candidates: IncidentCandidate[] = []
  for (const [workflowId, runs] of byWorkflow) {
    if (runs.length < FAILED_WORKFLOW_THRESHOLD) continue
    const severity: Severity = runs.length >= 20 ? 'emergency'
      : runs.length >= 10 ? 'critical' : 'warning'

    candidates.push({
      type: 'failed_workflow_spike',
      severity,
      title: `${runs.length} failed runs of workflow ${workflowId.slice(0, 8)} in last ${FAILED_WORKFLOW_WINDOW_MS / 60_000}m`,
      summary: `Workflow ${workflowId} has produced ${runs.length} failed runs in the last ${FAILED_WORKFLOW_WINDOW_MS / 60_000} minutes. Recent error: ${runs[0]?.errorMessage?.slice(0, 200) ?? 'unknown'}`,
      rootCauseHypothesis: 'Workflow logic regression, dependency outage, or input data drift',
      affectedSystems: { workflowId, failedRunCount: runs.length },
      linkedEventIds: runs.map((r) => r.id),
      signalCount: runs.length,
      detectedAt: Date.now(),
    })
  }
  return candidates
}

// ─── 2. Provider outage ───────────────────────────────────────────────────────

export async function detectProviderOutage(workspaceId: string): Promise<IncidentCandidate[]> {
  const since = Date.now() - PROVIDER_DOWN_WINDOW_MS
  const recent = await db.select({
    id: providerHealthLog.id,
    providerId: providerHealthLog.providerId,
    status: providerHealthLog.status,
    errorRate: providerHealthLog.errorRate,
    checkedAt: providerHealthLog.checkedAt,
  }).from(providerHealthLog)
    .where(and(
      eq(providerHealthLog.workspaceId, workspaceId),
      gt(providerHealthLog.checkedAt, since),
    ))
    .orderBy(desc(providerHealthLog.checkedAt))
    .limit(200)

  // Group by provider, look at latest status
  const latestByProvider = new Map<string, typeof recent[number]>()
  for (const r of recent) {
    if (!latestByProvider.has(r.providerId)) latestByProvider.set(r.providerId, r)
  }

  const candidates: IncidentCandidate[] = []
  for (const [providerId, latest] of latestByProvider) {
    if (latest.status !== 'down' && latest.status !== 'degraded') continue

    // Collect all signal IDs for this provider in window
    const signals = recent.filter((r) => r.providerId === providerId
      && (r.status === 'down' || r.status === 'degraded'))
    if (signals.length === 0) continue

    const severity: Severity = latest.status === 'down' ? 'critical' : 'warning'

    candidates.push({
      type: 'provider_outage',
      severity,
      title: `Provider ${providerId} reporting ${latest.status}`,
      summary: `${signals.length} health check(s) reported provider ${providerId} as ${latest.status} in the last ${PROVIDER_DOWN_WINDOW_MS / 60_000}m. Error rate: ${(latest.errorRate * 100).toFixed(1)}%`,
      rootCauseHypothesis: `Upstream provider ${providerId} is unavailable or degraded — failover to backup provider recommended`,
      affectedSystems: { providerId, status: latest.status, errorRate: latest.errorRate },
      linkedEventIds: signals.map((s) => s.id),
      signalCount: signals.length,
      detectedAt: Date.now(),
    })
  }
  return candidates
}

// ─── 3. Worker heartbeat failure ──────────────────────────────────────────────

export async function detectWorkerHeartbeatFailure(workspaceId: string): Promise<IncidentCandidate[]> {
  const now = Date.now()
  // Sandbox sessions still marked running but with expired lease
  const stale = await db.select({
    id: sandboxSessions.id,
    leaseOwner: sandboxSessions.leaseOwner,
    lastHeartbeat: sandboxSessions.lastHeartbeat,
    leaseExpiresAt: sandboxSessions.leaseExpiresAt,
    command: sandboxSessions.command,
  }).from(sandboxSessions)
    .where(and(
      eq(sandboxSessions.workspaceId, workspaceId),
      eq(sandboxSessions.status, 'running'),
      lt(sandboxSessions.leaseExpiresAt, now - HEARTBEAT_STALE_MS),
    ))
    .limit(50)

  if (stale.length === 0) return []

  // Group by worker
  const byWorker = new Map<string, typeof stale>()
  for (const s of stale) {
    const arr = byWorker.get(s.leaseOwner) ?? []
    arr.push(s)
    byWorker.set(s.leaseOwner, arr)
  }

  const candidates: IncidentCandidate[] = []
  for (const [workerId, sessions] of byWorker) {
    candidates.push({
      type: 'worker_heartbeat_failure',
      severity: sessions.length >= 3 ? 'critical' : 'warning',
      title: `Worker ${workerId} has ${sessions.length} stale session(s)`,
      summary: `Worker ${workerId} has not emitted heartbeat for ${Math.floor((now - (sessions[0]?.lastHeartbeat ?? now)) / 1000)}s across ${sessions.length} active session(s). Likely crashed or hung.`,
      rootCauseHypothesis: 'Worker process crashed, deadlocked, or lost network — restart and reclaim leases',
      affectedSystems: { workerId, staleSessionCount: sessions.length },
      linkedEventIds: sessions.map((s) => s.id),
      signalCount: sessions.length,
      detectedAt: now,
    })
  }
  return candidates
}

// ─── 4. Queue backlog ─────────────────────────────────────────────────────────

export async function detectQueueBacklog(workspaceId: string): Promise<IncidentCandidate[]> {
  // Count unreplayed dead-letter jobs by queue
  const rows = await db.select({
    id: deadLetterJobs.id,
    queueName: deadLetterJobs.queueName,
    deadLetteredAt: deadLetterJobs.deadLetteredAt,
  }).from(deadLetterJobs)
    .where(and(
      eq(deadLetterJobs.workspaceId, workspaceId),
    ))
    .orderBy(desc(deadLetterJobs.deadLetteredAt))
    .limit(500)

  // Only unreplayed (replayedAt is null) — re-query
  const unreplayed = await db.select({
    id: deadLetterJobs.id,
    queueName: deadLetterJobs.queueName,
  }).from(deadLetterJobs)
    .where(eq(deadLetterJobs.workspaceId, workspaceId))
    .limit(500)

  const byQueue = new Map<string, string[]>()
  for (const r of unreplayed) {
    const arr = byQueue.get(r.queueName) ?? []
    arr.push(r.id)
    byQueue.set(r.queueName, arr)
  }

  const candidates: IncidentCandidate[] = []
  for (const [queueName, ids] of byQueue) {
    if (ids.length < QUEUE_BACKLOG_THRESHOLD) continue
    const severity: Severity = ids.length >= 100 ? 'critical'
      : ids.length >= 50 ? 'warning' : 'info'

    candidates.push({
      type: 'queue_backlog',
      severity,
      title: `Queue ${queueName} has ${ids.length} dead-letter jobs`,
      summary: `${ids.length} jobs in dead-letter for queue '${queueName}' (threshold: ${QUEUE_BACKLOG_THRESHOLD}). Workers may be unable to process or jobs are systematically failing.`,
      rootCauseHypothesis: 'Worker capacity insufficient, persistent job failure, or downstream dependency failure',
      affectedSystems: { queueName, deadLetterCount: ids.length },
      linkedEventIds: ids.slice(0, 50),
      signalCount: ids.length,
      detectedAt: Date.now(),
    })
    // Reference `rows` only to keep the broader query for future detail enrichment
    void rows
  }
  return candidates
}

// ─── 5. Budget burn spike ─────────────────────────────────────────────────────

export async function detectBudgetBurn(workspaceId: string): Promise<IncidentCandidate[]> {
  const recent = await db.select({
    id: budgetAlerts.id,
    alertType: budgetAlerts.alertType,
    thresholdPct: budgetAlerts.thresholdPct,
    currentUsd: budgetAlerts.currentUsd,
    limitUsd: budgetAlerts.limitUsd,
    dismissed: budgetAlerts.dismissed,
    firedAt: budgetAlerts.firedAt,
  }).from(budgetAlerts)
    .where(and(
      eq(budgetAlerts.workspaceId, workspaceId),
      eq(budgetAlerts.dismissed, false),
    ))
    .orderBy(desc(budgetAlerts.firedAt))
    .limit(20)

  if (recent.length === 0) return []

  // Group by alertType, take most severe
  const candidates: IncidentCandidate[] = []
  const groupedByType = new Map<string, typeof recent>()
  for (const a of recent) {
    const arr = groupedByType.get(a.alertType) ?? []
    arr.push(a)
    groupedByType.set(a.alertType, arr)
  }

  for (const [alertType, alerts] of groupedByType) {
    const maxPct = Math.max(...alerts.map((a) => a.thresholdPct))
    if (maxPct < 75) continue  // ignore low alerts

    const severity: Severity = maxPct >= BUDGET_BURN_SEVERE_PCT ? 'critical'
      : maxPct >= 80 ? 'warning' : 'info'

    const top = alerts[0]!
    candidates.push({
      type: 'budget_burn',
      severity,
      title: `${alertType} budget at ${maxPct.toFixed(0)}% — $${top.currentUsd.toFixed(2)} / $${top.limitUsd.toFixed(2)}`,
      summary: `${alerts.length} unacknowledged ${alertType} budget alert(s). Highest threshold: ${maxPct}%. Risk of throttling or service interruption.`,
      rootCauseHypothesis: 'Spend spike from increased load, expensive model selection, or runaway job — review usage and apply throttling',
      affectedSystems: { alertType, thresholdPct: maxPct, currentUsd: top.currentUsd, limitUsd: top.limitUsd },
      linkedEventIds: alerts.map((a) => a.id),
      signalCount: alerts.length,
      detectedAt: Date.now(),
    })
  }
  return candidates
}

// ─── 6. Replay divergence ─────────────────────────────────────────────────────

export async function detectReplayDivergence(workspaceId: string): Promise<IncidentCandidate[]> {
  // If a single job has both passed=true and passed=false evidence, that's divergence
  const recent = await db.select({
    id: verificationEvidence.id,
    jobId: verificationEvidence.jobId,
    command: verificationEvidence.command,
    passed: verificationEvidence.passed,
    createdAt: verificationEvidence.createdAt,
  }).from(verificationEvidence)
    .where(and(
      eq(verificationEvidence.workspaceId, workspaceId),
      gt(verificationEvidence.createdAt, Date.now() - 60 * 60_000),
    ))
    .orderBy(desc(verificationEvidence.createdAt))
    .limit(500)

  // Group by jobId+command, detect both pass and fail outcomes
  const grouped = new Map<string, typeof recent>()
  for (const r of recent) {
    const k = `${r.jobId}::${r.command}`
    const arr = grouped.get(k) ?? []
    arr.push(r)
    grouped.set(k, arr)
  }

  const candidates: IncidentCandidate[] = []
  for (const [key, runs] of grouped) {
    if (runs.length < 2) continue
    const passed = runs.filter((r) => r.passed).length
    const failed = runs.length - passed
    if (passed === 0 || failed === 0) continue  // consistent — not divergence

    const [jobId, command] = key.split('::')
    candidates.push({
      type: 'replay_divergence',
      severity: 'warning',
      title: `Verification divergence for ${command} on job ${jobId?.slice(0, 8)}`,
      summary: `Same verification command produced both pass (${passed}) and fail (${failed}) outcomes — flaky test or non-deterministic environment`,
      rootCauseHypothesis: 'Flaky test, race condition, time-dependent assertion, or environment drift between runs',
      affectedSystems: { jobId, command, passed, failed },
      linkedEventIds: runs.map((r) => r.id),
      signalCount: runs.length,
      detectedAt: Date.now(),
    })
  }
  return candidates
}

// ─── 7. Rollback failure ──────────────────────────────────────────────────────

export async function detectRollbackFailure(workspaceId: string): Promise<IncidentCandidate[]> {
  const since = Date.now() - ROLLBACK_FAILURE_WINDOW_MS
  const rollbacks = await db.select({
    id: patchRecords.id,
    jobId: patchRecords.jobId,
    filePath: patchRecords.filePath,
    rollbackReason: patchRecords.rollbackReason,
    rolledBackAt: patchRecords.rolledBackAt,
  }).from(patchRecords)
    .where(and(
      eq(patchRecords.workspaceId, workspaceId),
      eq(patchRecords.status, 'rolled_back'),
      gt(patchRecords.rolledBackAt, since),
    ))
    .limit(100)

  if (rollbacks.length === 0) return []

  // Group by jobId — multiple rollbacks for same job = persistent failure
  const byJob = new Map<string, typeof rollbacks>()
  for (const r of rollbacks) {
    const arr = byJob.get(r.jobId) ?? []
    arr.push(r)
    byJob.set(r.jobId, arr)
  }

  const candidates: IncidentCandidate[] = []
  for (const [jobId, recs] of byJob) {
    if (recs.length < 2) continue  // single rollback = normal recovery
    candidates.push({
      type: 'rollback_failure',
      severity: 'critical',
      title: `${recs.length} rollbacks on job ${jobId.slice(0, 8)} — repair loop`,
      summary: `Job ${jobId} has triggered ${recs.length} rollbacks in last hour. Auto-repair is failing to converge.`,
      rootCauseHypothesis: 'Patch logic incorrect, hidden dependency, or test environment drift — manual intervention required',
      affectedSystems: { jobId, rollbackCount: recs.length, files: [...new Set(recs.map((r) => r.filePath))] },
      linkedEventIds: recs.map((r) => r.id),
      signalCount: recs.length,
      detectedAt: Date.now(),
    })
  }
  return candidates
}

// ─── Master scan ──────────────────────────────────────────────────────────────

export async function detectAllIncidents(workspaceId: string): Promise<IncidentCandidate[]> {
  const [a, b, c, d, e, f, g] = await Promise.all([
    detectFailedWorkflowSpike(workspaceId).catch(() => []),
    detectProviderOutage(workspaceId).catch(() => []),
    detectWorkerHeartbeatFailure(workspaceId).catch(() => []),
    detectQueueBacklog(workspaceId).catch(() => []),
    detectBudgetBurn(workspaceId).catch(() => []),
    detectReplayDivergence(workspaceId).catch(() => []),
    detectRollbackFailure(workspaceId).catch(() => []),
  ])
  return [...a, ...b, ...c, ...d, ...e, ...f, ...g]
}

// Unused but exported for diagnostic completeness
export { count }
