/**
 * Worker lifecycle — attaches start/heartbeat/stop events to a BullMQ worker.
 *
 * Usage:
 *   const cleanup = attachWorkerLifecycle(worker, opts)
 *   process.on('SIGTERM', async () => { await cleanup(); await worker.close() })
 */
import type { Worker, Job } from 'bullmq'
import type { Logger }      from 'pino'
import { QUEUE_CONFIG }     from './queues.js'
import { buildDeadLetterRecord, isJobExhausted, type DeadLetterRecord } from './dead-letter.js'

export interface WorkerLifecycleOptions {
  workerName:           string
  queueName:            string
  workerId:             string
  log:                  Logger
  emitEvent:            (type: string, workspaceId: string, payload: unknown) => Promise<void>
  onDeadLetter?:        (record: DeadLetterRecord) => Promise<void>
  heartbeatIntervalMs?: number
}

export function attachWorkerLifecycle(
  worker: Worker,
  opts:   WorkerLifecycleOptions,
): () => Promise<void> {
  const {
    workerName, queueName, workerId, log, emitEvent, onDeadLetter,
    heartbeatIntervalMs = QUEUE_CONFIG.HEARTBEAT_INTERVAL_MS,
  } = opts

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  const heartbeatTimer = setInterval(() => {
    void emitEvent('worker.heartbeat', '', {
      workerId, workerName, queueName,
      timestamp:  Date.now(),
      pid:        process.pid,
      memoryMb:   Math.round(process.memoryUsage().heapUsed / 1_048_576),
    }).catch((err: unknown) => log.warn({ err }, 'heartbeat emit failed'))
  }, heartbeatIntervalMs)

  if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
    heartbeatTimer.unref()
  }

  // ── Job listeners ──────────────────────────────────────────────────────────

  const onActive = (job: Job): void => {
    const ws = extractWorkspaceId(job)
    void emitEvent('queue.job.started', ws, {
      jobId: job.id, jobName: job.name, queueName, workspaceId: ws, workerId,
      attempt:   job.attemptsMade + 1,
      timestamp: Date.now(),
    }).catch(() => undefined)
  }

  const onCompleted = (job: Job): void => {
    const ws = extractWorkspaceId(job)
    void emitEvent('queue.job.completed', ws, {
      jobId: job.id, jobName: job.name, queueName, workspaceId: ws, workerId,
      durationMs: Date.now() - job.timestamp,
      timestamp:  Date.now(),
    }).catch(() => undefined)
  }

  const onFailed = (job: Job | undefined, err: Error): void => {
    const ws        = job ? extractWorkspaceId(job) : ''
    const exhausted = job ? isJobExhausted(job, QUEUE_CONFIG.DEFAULT_MAX_ATTEMPTS) : true

    void emitEvent('queue.job.failed', ws, {
      jobId: job?.id, jobName: job?.name ?? 'unknown', queueName, workspaceId: ws, workerId,
      error: err.message, attempts: job?.attemptsMade ?? 0, exhausted, timestamp: Date.now(),
    }).catch(() => undefined)

    // Retry scheduled (job not yet exhausted — BullMQ will re-queue)
    if (job && !exhausted) {
      const delay = QUEUE_CONFIG.DEFAULT_BACKOFF_DELAY_MS * Math.pow(2, job.attemptsMade)
      void emitEvent('queue.job.retry_scheduled', ws, {
        jobId: job.id, jobName: job.name, queueName, workspaceId: ws, workerId,
        attempt:   job.attemptsMade + 1,
        delayMs:   delay,
        timestamp: Date.now(),
      }).catch(() => undefined)
    }

    // Dead-letter (job exhausted)
    if (job && exhausted && onDeadLetter) {
      const record = buildDeadLetterRecord(
        { id: job.id, name: job.name, data: job.data as Record<string, unknown>,
          timestamp: job.timestamp, attemptsMade: job.attemptsMade, opts: job.opts },
        err, queueName, workerId,
      )
      void onDeadLetter(record)
        .then(() => emitEvent('queue.job.dead_lettered', record.workspaceId, {
          ...record, timestamp: Date.now(),
        }))
        .catch((e: unknown) => log.error({ err: e, jobId: job.id }, 'dead-letter persist failed'))
    }
  }

  const onStalled = (jobId: string): void => {
    log.warn({ jobId, queueName, workerId }, 'Job stalled')
    void emitEvent('queue.job.failed', '', {
      jobId, jobName: 'unknown', queueName, workspaceId: '', workerId,
      error: 'job stalled', stalled: true, timestamp: Date.now(),
    }).catch(() => undefined)
  }

  const onError = (err: Error): void => {
    log.error({ err, queueName, workerId }, 'Worker connection error')
  }

  worker.on('active',    onActive)
  worker.on('completed', onCompleted)
  worker.on('failed',    onFailed)
  worker.on('stalled',   onStalled)
  worker.on('error',     onError)

  // ── Emit worker.started ────────────────────────────────────────────────────
  void emitEvent('worker.started', '', {
    workerId, workerName, queueName,
    timestamp:   Date.now(),
    pid:         process.pid,
    nodeVersion: process.version,
  }).catch((err: unknown) => log.warn({ err }, 'worker.started emit failed'))

  // ── Cleanup ────────────────────────────────────────────────────────────────
  return async () => {
    clearInterval(heartbeatTimer)
    worker.off('active',    onActive)
    worker.off('completed', onCompleted)
    worker.off('failed',    onFailed)
    worker.off('stalled',   onStalled)
    worker.off('error',     onError)
    await emitEvent('worker.stopped', '', {
      workerId, workerName, queueName, timestamp: Date.now(),
    }).catch(() => undefined)
  }
}

function extractWorkspaceId(job: Job): string {
  return ((job.data as Record<string, unknown>)['workspaceId'] as string | undefined) ?? ''
}
