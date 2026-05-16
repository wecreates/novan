/**
 * Recovery worker — executes retry strategies, rollback instructions,
 * and scheduled maintenance tasks (detect-stuck-runs, retry-failed-runs,
 * cleanup-old-runs, health-check).
 *
 * Job types:
 *   handle-rejection     — workflow run rejected at approval gate
 *   retry-run            — re-enqueue a failed workflow run
 *   rollback-run         — execute registered rollback steps in reverse
 *   expire-approvals     — mark stale pending approvals as expired
 *   detect-stuck-runs    — timeout running workflows stuck > 5 minutes
 *   retry-failed-runs    — auto-retry eligible failed runs (attempt < 3, < 24h old)
 *   cleanup-old-runs     — delete completed/cancelled runs older than 7 days
 *   health-check         — emit status counts for last 24h
 */
import { Worker, Queue, type Job }                    from 'bullmq'
import { pino }                                        from 'pino'
import { eq, lt, lte, gte, and, inArray, sql }        from 'drizzle-orm'
import { drizzle }                                     from 'drizzle-orm/postgres-js'
import { v7 as uuidv7 }                               from 'uuid'
import postgres                                        from 'postgres'
import * as schema                                     from '@ops/db'
import { emitEvent }                                   from './events.js'
import {
  attachWorkerLifecycle,
  createRedisFromEnv,
  QUEUE_NAMES,
  QUEUE_CONFIG,
  type DeadLetterRecord,
} from '@ops/runtime-kernel'
import { deadLetterJobs }                              from '@ops/db'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'recovery-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const REDIS_URL = process.env['REDIS_URL']
if (!REDIS_URL) throw new Error('REDIS_URL is required')

const WORKER_ID = `${QUEUE_NAMES.RECOVERY}-worker-${process.pid}`

const queryClient    = postgres(connectionString, { max: 3, idle_timeout: 30 })
const db             = drizzle(queryClient)
const connection     = createRedisFromEnv()
const workflowQueue  = new Queue(QUEUE_NAMES.WORKFLOW, { connection })

// ─── Job handlers ─────────────────────────────────────────────────────────────

interface HandleRejectionJob {
  runId:       string
  workspaceId: string
  approvalId:  string
  reason:      string
}

interface RetryRunJob {
  runId:        string
  workspaceId:  string
  maxAttempts?: number
}

interface RollbackRunJob {
  runId:       string
  workspaceId: string
  reason:      string
}

interface ExpireApprovalsJob {
  workspaceId?: string  // optional — if omitted, process all workspaces
}

async function handleRejection(data: HandleRejectionJob): Promise<void> {
  const { runId, workspaceId, approvalId, reason } = data
  const logId = uuidv7()

  log.info({ runId, approvalId }, 'Handling approval rejection')

  await db.update(schema.workflowRuns)
    .set({ status: 'failed', failedAt: Date.now(), errorMessage: `Rejected: ${reason}` })
    .where(eq(schema.workflowRuns.id, runId))

  await db.insert(schema.recoveryLog).values({
    id:          logId,
    workspaceId,
    runId,
    strategy:    'rejection',
    reason,
    steps:       [{ action: 'approval_rejected', approvalId, reason }],
    status:      'completed',
    startedAt:   Date.now(),
    completedAt: Date.now(),
  })

  await emitEvent('workflow.run.failed', workspaceId, { runId, reason: `Approval rejected: ${reason}` })
}

async function handleRetryRun(data: RetryRunJob): Promise<void> {
  const { runId, workspaceId, maxAttempts = 3 } = data

  const [run] = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId))
  if (!run) {
    log.warn({ runId }, 'Run not found for retry')
    return
  }

  if (run.attempt >= maxAttempts) {
    log.warn({ runId, attempt: run.attempt }, 'Max retry attempts reached')

    await db.insert(schema.recoveryLog).values({
      id:          uuidv7(),
      workspaceId,
      runId,
      strategy:    'retry',
      reason:      'Max attempts exhausted',
      steps:       [{ action: 'retry_exhausted', attempt: run.attempt, maxAttempts }],
      status:      'failed',
      startedAt:   Date.now(),
      completedAt: Date.now(),
    })

    await emitEvent('workflow.run.failed', workspaceId, {
      runId,
      reason: `Max retry attempts (${maxAttempts}) exhausted`,
    })
    return
  }

  // Increment attempt + reset to pending
  await db.update(schema.workflowRuns)
    .set({
      status:       'pending',
      attempt:      run.attempt + 1,
      errorMessage: null,
      failedAt:     null,
      startedAt:    null,
      completedAt:  null,
    })
    .where(eq(schema.workflowRuns.id, runId))

  // Re-enqueue
  await workflowQueue.add('execute-workflow', {
    runId,
    workspaceId,
    attempt: run.attempt + 1,
  }, { priority: 2 })

  await db.insert(schema.recoveryLog).values({
    id:          uuidv7(),
    workspaceId,
    runId,
    strategy:    'retry',
    reason:      'Automatic retry after failure',
    steps:       [{ action: 'requeued', newAttempt: run.attempt + 1 }],
    status:      'completed',
    startedAt:   Date.now(),
    completedAt: Date.now(),
  })

  await emitEvent('workflow.run.recovery.started', workspaceId, { runId, strategy: 'retry' })
  log.info({ runId, attempt: run.attempt + 1 }, 'Run re-enqueued for retry')
}

async function handleRollback(data: RollbackRunJob): Promise<void> {
  const { runId, workspaceId, reason } = data
  const logId = uuidv7()

  log.info({ runId }, 'Starting rollback')

  await db.update(schema.workflowRuns)
    .set({ status: 'cancelled' })
    .where(eq(schema.workflowRuns.id, runId))

  // Load step runs that have rollback instructions
  const completedSteps = await db.select()
    .from(schema.stepRuns)
    .where(
      and(
        eq(schema.stepRuns.runId, runId),
        eq(schema.stepRuns.status, 'completed'),
      )
    )

  const rollbackSteps = completedSteps
    .filter((s) => s.rollback !== null)
    .reverse()  // reverse order for rollback

  const rollbackResults: { stepId: string; status: string; error?: string }[] = []

  for (const step of rollbackSteps) {
    try {
      // TODO: actual rollback dispatch per step type
      // For now: record intent and mark as rolled back
      log.info({ stepId: step.stepId }, 'Rolling back step')
      rollbackResults.push({ stepId: step.stepId, status: 'rolled_back' })

      await db.update(schema.stepRuns)
        .set({ status: 'skipped' })  // use skipped as rolled-back marker
        .where(eq(schema.stepRuns.id, step.id))
    } catch (err) {
      const errMsg = (err as Error).message
      log.error({ stepId: step.stepId, err: errMsg }, 'Rollback step failed')
      rollbackResults.push({ stepId: step.stepId, status: 'rollback_failed', error: errMsg })
    }
  }

  await db.insert(schema.recoveryLog).values({
    id:          logId,
    workspaceId,
    runId,
    strategy:    'rollback',
    reason,
    steps:       rollbackResults,
    status:      rollbackResults.every((r) => r.status === 'rolled_back') ? 'completed' : 'partial',
    startedAt:   Date.now(),
    completedAt: Date.now(),
  })

  await emitEvent('workflow.run.recovery.completed', workspaceId, {
    runId,
    strategy:       'rollback',
    stepsRolledBack: rollbackResults.filter((r) => r.status === 'rolled_back').length,
  })

  log.info({ runId, steps: rollbackResults.length }, 'Rollback complete')
}

async function handleExpireApprovals(data: ExpireApprovalsJob): Promise<{ expired: number }> {
  const now = Date.now()

  const whereClause = data.workspaceId
    ? and(
        eq(schema.approvals.status, 'pending'),
        lt(schema.approvals.expiresAt, now),
        eq(schema.approvals.workspaceId, data.workspaceId),
      )
    : and(
        eq(schema.approvals.status, 'pending'),
        lt(schema.approvals.expiresAt, now),
      )

  const expired = await db.update(schema.approvals)
    .set({ status: 'expired', resolvedAt: now })
    .where(whereClause)
    .returning({ id: schema.approvals.id, runId: schema.approvals.runId, workspaceId: schema.approvals.workspaceId })

  for (const approval of expired) {
    // Fail the associated run
    await db.update(schema.workflowRuns)
      .set({ status: 'failed', failedAt: now, errorMessage: 'Approval expired' })
      .where(
        and(
          eq(schema.workflowRuns.id, approval.runId),
          eq(schema.workflowRuns.status, 'awaiting_approval'),
        )
      )

    await emitEvent('workflow.approval.expired', String(approval.workspaceId), {
      approvalId: approval.id,
      runId:      approval.runId,
    })
  }

  log.info({ expired: expired.length }, 'Approvals expired')
  return { expired: expired.length }
}

// ─── Scheduled maintenance handlers ──────────────────────────────────────────

async function detectStuckRuns(): Promise<{ stuckCount: number; fixed: number }> {
  const cutoff = Date.now() - 5 * 60 * 1_000  // 5 minutes ago

  // Runs that started > 5min ago and are still 'running'
  // Use startedAt for stuck detection (no updatedAt on workflowRuns)
  const stuck = await db
    .select({ id: schema.workflowRuns.id, workspaceId: schema.workflowRuns.workspaceId })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.status, 'running'),
        lte(schema.workflowRuns.startedAt, cutoff),
      ),
    )

  let fixed = 0
  for (const run of stuck) {
    await db
      .update(schema.workflowRuns)
      .set({ status: 'failed', failedAt: Date.now(), errorMessage: 'Timeout: run exceeded 5 minute limit' })
      .where(eq(schema.workflowRuns.id, run.id))

    await emitEvent('workflow.run.timeout', run.workspaceId, { runId: run.id })
    fixed++
  }

  log.info({ stuckCount: stuck.length, fixed }, 'detect-stuck-runs complete')
  return { stuckCount: stuck.length, fixed }
}

async function retryFailedRuns(): Promise<{ retriedCount: number }> {
  const since = Date.now() - 24 * 60 * 60 * 1_000  // 24h ago

  // attempt starts at 1; < 3 means at most 2 prior attempts, allowing a 3rd
  const eligible = await db
    .select({ id: schema.workflowRuns.id, workspaceId: schema.workflowRuns.workspaceId, attempt: schema.workflowRuns.attempt })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.status, 'failed'),
        lt(schema.workflowRuns.attempt, 3),
        gte(schema.workflowRuns.triggeredAt, since),
      ),
    )

  let retriedCount = 0
  for (const run of eligible) {
    await db
      .update(schema.workflowRuns)
      .set({ status: 'pending', attempt: run.attempt + 1, errorMessage: null })
      .where(eq(schema.workflowRuns.id, run.id))

    await emitEvent('workflow.run.retry-scheduled', run.workspaceId, { runId: run.id, attempt: run.attempt + 1 })
    retriedCount++
  }

  log.info({ retriedCount }, 'retry-failed-runs complete')
  return { retriedCount }
}

async function cleanupOldRuns(): Promise<{ deletedCount: number }> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000  // 7 days ago

  const deleted = await db
    .delete(schema.workflowRuns)
    .where(
      and(
        inArray(schema.workflowRuns.status, ['completed', 'cancelled']),
        lte(schema.workflowRuns.triggeredAt, cutoff),
      ),
    )
    .returning({ id: schema.workflowRuns.id })

  const deletedCount = deleted.length
  log.info({ deletedCount }, 'cleanup-old-runs complete')
  return { deletedCount }
}

async function runHealthCheck(): Promise<void> {
  const since = Date.now() - 24 * 60 * 60 * 1_000

  const rows = await db
    .select({
      status: schema.workflowRuns.status,
      count:  sql<number>`count(*)::int`,
    })
    .from(schema.workflowRuns)
    .where(gte(schema.workflowRuns.triggeredAt, since))
    .groupBy(schema.workflowRuns.status)

  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.status] = row.count

  // Emit to a system-wide workspace placeholder; real implementations pass a workspaceId
  await emitEvent('recovery.health-check.completed', 'system', { counts, windowMs: 24 * 60 * 60 * 1_000 })
  log.info({ counts }, 'health-check complete')
}

// ─── Scheduled repeat job registration (idempotent) ──────────────────────────

const recoveryQueue = new Queue(QUEUE_NAMES.RECOVERY, { connection })

async function registerScheduledJobs(): Promise<void> {
  const jobs: Array<{ name: string; every: number }> = [
    { name: 'detect-stuck-runs',  every: 2 * 60 * 1_000 },      // 2 min
    { name: 'retry-failed-runs',  every: 5 * 60 * 1_000 },      // 5 min
    { name: 'cleanup-old-runs',   every: 24 * 60 * 60 * 1_000 }, // 24 h
    { name: 'health-check',       every: 60 * 60 * 1_000 },      // 1 h
  ]

  for (const { name, every } of jobs) {
    await recoveryQueue.add(
      name,
      {},
      {
        repeat:    { every },
        jobId:     `scheduled:${name}`,  // idempotent key
        removeOnComplete: { count: 5 },
        removeOnFail:     { count: 10 },
      },
    )
    log.info({ name, everyMs: every }, 'Scheduled repeat job registered')
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  QUEUE_NAMES.RECOVERY,
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing recovery job')

    switch (job.name) {
      case 'handle-rejection':
        return handleRejection(job.data as HandleRejectionJob)
      case 'retry-run':
        return handleRetryRun(job.data as RetryRunJob)
      case 'rollback-run':
        return handleRollback(job.data as RollbackRunJob)
      case 'expire-approvals':
        return handleExpireApprovals(job.data as ExpireApprovalsJob)
      case 'detect-stuck-runs':
        return detectStuckRuns()
      case 'retry-failed-runs':
        return retryFailedRuns()
      case 'cleanup-old-runs':
        return cleanupOldRuns()
      case 'health-check':
        return runHealthCheck()
      default:
        log.warn({ jobName: job.name }, 'Unknown job type')
        return { skipped: true }
    }
  },
  {
    connection,
    concurrency:     1,
    stalledInterval: QUEUE_CONFIG.STALL_INTERVAL_MS,
    maxStalledCount: QUEUE_CONFIG.MAX_STALL_COUNT,
    lockDuration:    QUEUE_CONFIG.LOCK_DURATION_MS,
  },
)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName:  'recovery-worker',
  queueName:   QUEUE_NAMES.RECOVERY,
  workerId:    WORKER_ID,
  log,
  emitEvent,
  onDeadLetter: async (record: DeadLetterRecord) => {
    await db.insert(deadLetterJobs).values({
      id:             record.id,
      queueName:      record.queueName,
      jobId:          record.jobId,
      jobName:        record.jobName,
      workspaceId:    record.workspaceId,
      payload:        record.payload,
      error:          record.error,
      attempts:       record.attempts,
      workerId:       record.workerId,
      traceId:        record.traceId ?? null,
      firstFailedAt:  record.firstFailedAt,
      deadLetteredAt: record.deadLetteredAt,
    })
    log.warn({ jobId: record.jobId, error: record.error }, 'Recovery job dead-lettered')
  },
})

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'Recovery worker shutting down')
  await cleanupLifecycle()
  await worker.close()
  await recoveryQueue.close()
  await queryClient.end()
  connection.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

// ─── Startup ──────────────────────────────────────────────────────────────────

void registerScheduledJobs().then(() => {
  log.info({ workerId: WORKER_ID }, 'Recovery worker started')
}).catch((err: unknown) => {
  log.error({ err }, 'Failed to register scheduled jobs')
  process.exit(1)
})
