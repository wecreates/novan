/**
 * Briefing worker — processes executive briefing generation jobs.
 *
 * Job types:
 *   generate-briefing — aggregate live data and produce structured briefing
 */
import { Worker, type Job }              from 'bullmq'
import { pino }                          from 'pino'
import { eq }                            from 'drizzle-orm'
import { createDb, briefings, events, startWorkerHeartbeat, deadLetterJobs } from '@ops/db'
import { createRedisFromEnv, attachWorkerLifecycle, installProcessSafetyNet } from '@ops/runtime-kernel'
import { EVENT_TYPES, EVENT_SCHEMA_VERSION }         from '@ops/event-contracts'
import { v7 as uuidv7 }                  from 'uuid'
import { generateBriefing, persistBriefing } from './generator.js'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'briefing-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const db    = createDb(connectionString, 3, 'ops-briefing-worker')
startWorkerHeartbeat({ db, name: 'briefing-worker', capabilities: ['briefing', 'summary'] })
const redis = createRedisFromEnv()

// ─── Event emitter ────────────────────────────────────────────────────────────

async function emitEvent(
  type: string,
  workspaceId: string,
  payload: unknown,
): Promise<void> {
  if (!workspaceId) return
  try {
    await db.insert(events).values({
      id:            uuidv7(),
      type,
      workspaceId,
      payload:       payload as Record<string, unknown>,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'briefing-worker',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     Date.now(),
    })
  } catch (err) {
    log.warn({ err, type }, 'Failed to emit event')
  }
}

// ─── Job handler ──────────────────────────────────────────────────────────────

interface GenerateBriefingJob {
  workspaceId:  string
  requestedBy?: string
  traceId?:     string
  windowMs?:    number
}

async function handleGenerateBriefing(
  data: GenerateBriefingJob,
): Promise<{ briefingId: string; itemCount: number; sections: string[] }> {
  const { workspaceId, requestedBy = 'system', windowMs = 86_400_000 } = data
  const traceId    = data.traceId ?? uuidv7()
  const briefingId = uuidv7()
  const start      = Date.now()

  // Insert placeholder row (status = generating)
  await db.insert(briefings).values({
    id:          briefingId,
    workspaceId,
    status:      'generating',
    requestedBy,
    traceId,
    windowMs,
    createdAt:   start,
  })

  log.info({ briefingId, workspaceId }, 'Generating briefing…')

  try {
    const generated = await generateBriefing(db, workspaceId, windowMs)
    await persistBriefing(db, briefingId, workspaceId, traceId, requestedBy, windowMs, generated)

    const sections   = [...new Set(generated.items.map((i) => i.section))]
    const durationMs = Date.now() - start

    log.info({ briefingId, items: generated.items.length, durationMs }, 'Briefing generated')

    await emitEvent(EVENT_TYPES.BRIEFING_GENERATED, workspaceId, {
      workspaceId,
      briefingId,
      requestedBy,
      itemCount:  generated.items.length,
      sections,
      durationMs,
      traceId,
      timestamp:  Date.now(),
    })

    return { briefingId, itemCount: generated.items.length, sections }
  } catch (err) {
    // Mark briefing as failed
    await db.update(briefings)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(briefings.id, briefingId))
      .catch(() => null)
    throw err
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  'briefing',
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing briefing job')

    switch (job.name) {
      case 'generate-briefing':
        return handleGenerateBriefing(job.data as GenerateBriefingJob)

      default:
        log.warn({ jobName: job.name }, 'Unknown job type')
        return { skipped: true }
    }
  },
  {
    connection:  redis,
    concurrency: 2,
    limiter:     { max: 5, duration: 1_000 },
  },
)

// ─── Dead-letter persistence ──────────────────────────────────────────────────
async function persistDeadLetter(record: import('@ops/runtime-kernel').DeadLetterRecord): Promise<void> {
  try {
    await db.insert(deadLetterJobs).values({
      id: record.id, queueName: record.queueName, jobId: record.jobId, jobName: record.jobName,
      workspaceId: record.workspaceId, payload: record.payload, error: record.error,
      attempts: record.attempts, workerId: record.workerId, traceId: record.traceId ?? null,
      firstFailedAt: record.firstFailedAt, deadLetteredAt: record.deadLetteredAt,
    })
    log.warn({ jobId: record.jobId, error: record.error }, 'briefing-worker job dead-lettered')
  } catch (e) { log.error({ err: e, jobId: record.jobId }, 'failed to persist dead letter') }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const workerId = `briefing-worker-${process.pid}`
const cleanup  = attachWorkerLifecycle(worker, {
  workerName: 'briefing-worker',
  queueName:  'briefing',
  workerId,
  log,
  emitEvent,
  onDeadLetter: persistDeadLetter,
})

// SHUTDOWN — previously `worker.close()` returned void and the inner
// .then() ran immediately, exiting before close drained jobs.
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'briefing-worker shutting down')
  try { await cleanup() } catch { /* */ }
  try { await worker.close() } catch { /* */ }
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })
installProcessSafetyNet({ workerName: 'briefing-worker', log })

log.info('Briefing worker started')
