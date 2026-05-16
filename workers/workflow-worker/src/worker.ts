/**
 * Workflow Worker — BullMQ consumer for the 'workflow' queue.
 *
 * Responsibilities:
 *   - Dequeue workflow run jobs
 *   - Load run + definition from DB
 *   - Execute steps sequentially or in parallel per dependency graph
 *   - Handle approvals (pause → resume)
 *   - Persist step results to DB
 *   - Emit lifecycle events (started/heartbeat/stopped)
 *   - On failure: dead-letter exhausted jobs
 *   - Save checkpoint state for replay capability
 *
 * Concurrency: configurable via WORKFLOW_WORKER_CONCURRENCY env.
 * Graceful shutdown: drain in-flight jobs before exit.
 */
import { Worker, type Job }        from 'bullmq'
import pino                        from 'pino'
import { db }                      from './db.js'
import { executeWorkflowRun }      from './executor.js'
import { emitEvent }               from './events.js'
import {
  attachWorkerLifecycle,
  createRedisFromEnv,
  QUEUE_NAMES,
  QUEUE_CONFIG,
  type DeadLetterRecord,
} from '@ops/runtime-kernel'
import { deadLetterJobs }          from '@ops/db'
import {
  openWorkflowTrace,
  closeWorkflowTrace,
  openTaskTrace,
  closeTaskTrace,
  openFailureLineage,
} from '@ops/service-observability'
import {
  createSnapshot,
  createCheckpoint,
} from '@ops/service-recovery'

const log = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  ...(process.env['NODE_ENV'] === 'development'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
})

const REDIS_URL   = process.env['REDIS_URL']
if (!REDIS_URL) throw new Error('REDIS_URL is required')

const CONCURRENCY = Number(process.env['WORKFLOW_WORKER_CONCURRENCY'] ?? 5)
const WORKER_ID   = `${QUEUE_NAMES.WORKFLOW}-worker-${process.pid}`

const connection  = createRedisFromEnv()

// ─── Job type definitions ──────────────────────────────────────────────────────

interface ExecuteWorkflowJob {
  runId:       string
  workflowId:  string
  workspaceId: string
  traceId:     string
}

interface ResumeWorkflowJob {
  runId:       string
  workspaceId: string
  approvalId:  string
  approved:    boolean
  resolvedBy:  string
  traceId?:    string
}

type WorkflowJobData = ExecuteWorkflowJob | ResumeWorkflowJob

// ─── Dead-letter persistence ───────────────────────────────────────────────────

async function persistDeadLetter(record: DeadLetterRecord): Promise<void> {
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
  log.warn({ jobId: record.jobId, error: record.error }, 'Job dead-lettered')
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker<WorkflowJobData>(
  QUEUE_NAMES.WORKFLOW,
  async (job: Job<WorkflowJobData>) => {
    const { name, data } = job
    log.info({ jobId: job.id, jobName: name }, 'Processing workflow job')

    switch (name) {
      case 'execute-workflow': {
        const d = data as ExecuteWorkflowJob
        await executeWorkflowRun({
          runId:       d.runId,
          workspaceId: d.workspaceId,
          traceId:     d.traceId,
          log:         log.child({ runId: d.runId, traceId: d.traceId }),
          db,
          emitEvent,
          observability: {
            openWorkflowTrace,
            closeWorkflowTrace,
            openTaskTrace,
            closeTaskTrace,
            openFailureLineage,
          },
          recovery: {
            createSnapshot,
            createCheckpoint,
          },
        })
        break
      }

      case 'resume-workflow': {
        const d = data as ResumeWorkflowJob
        log.info({ runId: d.runId, approved: d.approved }, 'Resuming workflow after approval')
        await executeWorkflowRun({
          runId:       d.runId,
          workspaceId: d.workspaceId,
          traceId:     d.traceId ?? '',
          resumeFromApproval: {
            approvalId: d.approvalId,
            approved:   d.approved,
            resolvedBy: d.resolvedBy,
          },
          log:  log.child({ runId: d.runId }),
          db,
          emitEvent,
          observability: {
            openWorkflowTrace,
            closeWorkflowTrace,
            openTaskTrace,
            closeTaskTrace,
            openFailureLineage,
          },
          recovery: {
            createSnapshot,
            createCheckpoint,
          },
        })
        break
      }

      default:
        log.warn({ jobName: name }, 'Unknown workflow job type — skipping')
    }
  },
  {
    connection,
    concurrency:     CONCURRENCY,
    stalledInterval: QUEUE_CONFIG.STALL_INTERVAL_MS,
    maxStalledCount: QUEUE_CONFIG.MAX_STALL_COUNT,
    lockDuration:    QUEUE_CONFIG.LOCK_DURATION_MS,
  },
)

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName:  'workflow-worker',
  queueName:   QUEUE_NAMES.WORKFLOW,
  workerId:    WORKER_ID,
  log,
  emitEvent,
  onDeadLetter: persistDeadLetter,
})

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'Workflow worker shutting down')
  await cleanupLifecycle()
  await worker.close()
  connection.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT',  () => void shutdown('SIGINT'))

log.info({ workerId: WORKER_ID, concurrency: CONCURRENCY }, 'Workflow worker started')
