/**
 * Analytics worker — aggregation, cleanup, and daily reporting jobs.
 *
 * Job types:
 *   aggregate-ai-usage          — group aiUsage by (workspaceId, provider, model, date)
 *   aggregate-workflow-metrics  — group workflowRuns by (workspaceId, status, date)
 *   cleanup-old-events          — delete events older than 30 days
 *   generate-daily-report       — combine AI + workflow metrics into a briefing record
 */

import { Worker, Queue, type Job } from 'bullmq'
import { pino }                    from 'pino'
import { eq, lte, and, gte, sql as sqlFn } from 'drizzle-orm'
import { drizzle }                 from 'drizzle-orm/postgres-js'
import postgres                    from 'postgres'
import { v7 as uuidv7 }            from 'uuid'
import * as schema from '@ops/db'
import {
  attachWorkerLifecycle,
  createRedisFromEnv,
} from '@ops/runtime-kernel'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'analytics-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) throw new Error('DATABASE_URL is required')

const WORKER_ID   = `analytics-worker-${process.pid}`
const QUEUE_NAME  = 'analytics'

const queryClient = postgres(DATABASE_URL, { max: 3, idle_timeout: 30 })
const db          = drizzle(queryClient)
const connection  = createRedisFromEnv()

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emitEvent(
  type:        string,
  workspaceId: string,
  payload:     unknown,
): Promise<void> {
  if (!workspaceId) return  // skip worker-level events without workspace scope
  try {
    await db.insert(schema.events).values({
      id:            uuidv7(),
      type,
      workspaceId,
      payload:       payload as Record<string, unknown>,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'analytics-worker',
      version:       1,
      createdAt:     Date.now(),
    })
  } catch (err) {
    log.warn({ err, type }, 'Failed to emit event')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns midnight UTC timestamp (ms) for a given date offset from today. */
function dayBoundaryMs(offsetDays: number): number {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.getTime()
}

/** ISO date string (YYYY-MM-DD) from a unix-ms timestamp. */
function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// ─── Job: aggregate-ai-usage ──────────────────────────────────────────────────

interface AggregateAiUsageJob {
  workspaceId?: string   // if omitted, all workspaces
  windowHours?: number   // default 24
}

async function handleAggregateAiUsage(data: AggregateAiUsageJob): Promise<Record<string, unknown>> {
  const windowHours = data.windowHours ?? 24
  const since       = Date.now() - windowHours * 60 * 60 * 1_000

  // Fetch rows within the window (optionally scoped)
  const conditions = [gte(schema.aiUsage.timestamp, since)]
  if (data.workspaceId) conditions.push(eq(schema.aiUsage.workspaceId, data.workspaceId))

  const rows = await db
    .select({
      workspaceId:  schema.aiUsage.workspaceId,
      provider:     schema.aiUsage.provider,
      model:        schema.aiUsage.model,
      timestamp:    schema.aiUsage.timestamp,
      promptTokens: schema.aiUsage.promptTokens,
      outputTokens: schema.aiUsage.outputTokens,
      costUsd:      schema.aiUsage.costUsd,
      latencyMs:    schema.aiUsage.latencyMs,
    })
    .from(schema.aiUsage)
    .where(and(...conditions))

  // Group in-process by (workspaceId, provider, model, date)
  type Key = string
  interface Bucket {
    workspaceId: string
    provider:    string
    model:       string
    date:        string
    totalTokens: number
    totalCost:   number
    totalReqs:   number
    totalLatency: number
  }

  const buckets = new Map<Key, Bucket>()

  for (const r of rows) {
    const date = toDateStr(r.timestamp)
    const key: Key = `${r.workspaceId}|${r.provider}|${r.model}|${date}`
    const b = buckets.get(key) ?? {
      workspaceId: r.workspaceId,
      provider:    r.provider,
      model:       r.model,
      date,
      totalTokens: 0,
      totalCost:   0,
      totalReqs:   0,
      totalLatency: 0,
    }
    b.totalTokens  += r.promptTokens + r.outputTokens
    b.totalCost    += r.costUsd
    b.totalReqs    += 1
    b.totalLatency += r.latencyMs
    buckets.set(key, b)
  }

  const summary = [...buckets.values()].map((b) => ({
    ...b,
    avgLatencyMs: b.totalReqs > 0 ? Math.round(b.totalLatency / b.totalReqs) : 0,
  }))

  log.info({ buckets: summary.length, rows: rows.length }, 'AI usage aggregated')

  // Emit one event per workspace
  const byWs = new Map<string, typeof summary>()
  for (const s of summary) {
    const list = byWs.get(s.workspaceId) ?? []
    list.push(s)
    byWs.set(s.workspaceId, list)
  }

  await Promise.all(
    [...byWs.entries()].map(([wsId, items]) =>
      emitEvent('analytics.ai-usage.aggregated', wsId, { items, aggregatedAt: Date.now() }),
    ),
  )

  return { buckets: summary.length, rows: rows.length }
}

// ─── Job: aggregate-workflow-metrics ─────────────────────────────────────────

interface AggregateWorkflowMetricsJob {
  workspaceId?: string
  windowHours?: number   // default 24
}

async function handleAggregateWorkflowMetrics(data: AggregateWorkflowMetricsJob): Promise<Record<string, unknown>> {
  const windowHours = data.windowHours ?? 24
  const since       = Date.now() - windowHours * 60 * 60 * 1_000

  const conditions = [gte(schema.workflowRuns.triggeredAt, since)]
  if (data.workspaceId) conditions.push(eq(schema.workflowRuns.workspaceId, data.workspaceId))

  const rows = await db
    .select({
      workspaceId:  schema.workflowRuns.workspaceId,
      status:       schema.workflowRuns.status,
      triggeredAt:  schema.workflowRuns.triggeredAt,
      startedAt:    schema.workflowRuns.startedAt,
      completedAt:  schema.workflowRuns.completedAt,
    })
    .from(schema.workflowRuns)
    .where(and(...conditions))

  // Group by (workspaceId, status, date)
  type WKey = string
  interface WBucket {
    workspaceId: string
    status:      string
    date:        string
    count:       number
    totalDuration: number
    completedCount: number
  }

  const buckets = new Map<WKey, WBucket>()

  for (const r of rows) {
    const date   = toDateStr(r.triggeredAt)
    const status = r.status
    const key: WKey = `${r.workspaceId}|${status}|${date}`
    const b = buckets.get(key) ?? {
      workspaceId:    r.workspaceId,
      status,
      date,
      count:          0,
      totalDuration:  0,
      completedCount: 0,
    }
    b.count += 1
    if (status === 'completed' && r.startedAt !== null && r.completedAt !== null) {
      b.totalDuration  += r.completedAt - r.startedAt
      b.completedCount += 1
    }
    buckets.set(key, b)
  }

  const summary = [...buckets.values()].map((b) => ({
    ...b,
    avgDurationMs: b.completedCount > 0 ? Math.round(b.totalDuration / b.completedCount) : null,
  }))

  log.info({ buckets: summary.length, runs: rows.length }, 'Workflow metrics aggregated')

  const byWs = new Map<string, typeof summary>()
  for (const s of summary) {
    const list = byWs.get(s.workspaceId) ?? []
    list.push(s)
    byWs.set(s.workspaceId, list)
  }

  await Promise.all(
    [...byWs.entries()].map(([wsId, items]) =>
      emitEvent('analytics.workflow-metrics.aggregated', wsId, { items, aggregatedAt: Date.now() }),
    ),
  )

  return { buckets: summary.length, runs: rows.length }
}

// ─── Job: cleanup-old-events ──────────────────────────────────────────────────

interface CleanupOldEventsJob {
  workspaceId?:   string
  retentionDays?: number   // default 30
}

async function handleCleanupOldEvents(data: CleanupOldEventsJob): Promise<Record<string, unknown>> {
  const retentionDays = data.retentionDays ?? 30
  const cutoff        = Date.now() - retentionDays * 24 * 60 * 60 * 1_000

  const conditions = [lte(schema.events.createdAt, cutoff)]
  if (data.workspaceId) conditions.push(eq(schema.events.workspaceId, data.workspaceId))

  // Count before deleting so we can report
  const [countRow] = await db
    .select({ n: sqlFn<number>`count(*)::int` })
    .from(schema.events)
    .where(and(...conditions))

  const count = countRow?.n ?? 0

  if (count > 0) {
    await db.delete(schema.events).where(and(...conditions))
  }

  log.info({ count, cutoffMs: cutoff, retentionDays }, 'Old events cleaned up')

  // Emit scoped to workspace if provided, else use a sentinel
  const wsId = data.workspaceId ?? 'system'
  await emitEvent('analytics.cleanup.completed', wsId, {
    count,
    cutoffMs:       cutoff,
    retentionDays,
    cleanedAt:      Date.now(),
  })

  return { count }
}

// ─── Job: generate-daily-report ───────────────────────────────────────────────

interface GenerateDailyReportJob {
  workspaceId?: string   // if omitted, all workspaces
  targetDate?:  string   // YYYY-MM-DD; defaults to yesterday
}

async function handleGenerateDailyReport(data: GenerateDailyReportJob): Promise<Record<string, unknown>> {
  // Resolve target date window (previous day by default)
  let dayStart: number
  let dayEnd:   number

  if (data.targetDate) {
    dayStart = new Date(`${data.targetDate}T00:00:00Z`).getTime()
    dayEnd   = dayStart + 86_400_000
  } else {
    dayEnd   = dayBoundaryMs(0)   // today midnight UTC
    dayStart = dayEnd - 86_400_000
  }

  const dateStr = toDateStr(dayStart)

  // Fetch workspaces to report on
  let workspaceIds: string[]
  if (data.workspaceId) {
    workspaceIds = [data.workspaceId]
  } else {
    const wsList = await db.select({ id: schema.workspaces.id }).from(schema.workspaces)
    workspaceIds = wsList.map((r) => r.id)
  }

  let briefingsCreated = 0

  await Promise.all(
    workspaceIds.map(async (wsId) => {
      // Aggregate AI usage for the day
      const aiRows = await db
        .select({
          totalPrompt:  sqlFn<number>`sum(${schema.aiUsage.promptTokens})::int`,
          totalOutput:  sqlFn<number>`sum(${schema.aiUsage.outputTokens})::int`,
          totalCost:    sqlFn<number>`sum(${schema.aiUsage.costUsd})`,
          totalReqs:    sqlFn<number>`count(*)::int`,
        })
        .from(schema.aiUsage)
        .where(
          and(
            eq(schema.aiUsage.workspaceId, wsId),
            gte(schema.aiUsage.timestamp, dayStart),
            lte(schema.aiUsage.timestamp, dayEnd),
          ),
        )

      const ai = aiRows[0] ?? { totalPrompt: 0, totalOutput: 0, totalCost: 0, totalReqs: 0 }

      // Aggregate workflow runs for the day
      const wfRows = await db
        .select({
          status: schema.workflowRuns.status,
          count:  sqlFn<number>`count(*)::int`,
        })
        .from(schema.workflowRuns)
        .where(
          and(
            eq(schema.workflowRuns.workspaceId, wsId),
            gte(schema.workflowRuns.triggeredAt, dayStart),
            lte(schema.workflowRuns.triggeredAt, dayEnd),
          ),
        )
        .groupBy(schema.workflowRuns.status)

      const statusCounts: Record<string, number> = {}
      for (const row of wfRows) statusCounts[row.status] = row.count

      const totalRuns      = Object.values(statusCounts).reduce((a, b) => a + b, 0)
      const completedRuns  = statusCounts['completed'] ?? 0
      const failedRuns     = statusCounts['failed'] ?? 0

      const summaryText =
        `Daily report for ${dateStr}: ` +
        `${ai.totalReqs} AI requests, ` +
        `${(ai.totalPrompt ?? 0) + (ai.totalOutput ?? 0)} tokens, ` +
        `$${(ai.totalCost ?? 0).toFixed(4)} cost. ` +
        `${totalRuns} workflow runs (${completedRuns} completed, ${failedRuns} failed).`

      // Insert briefing record
      try {
        const briefingId = uuidv7()
        await db.insert(schema.briefings).values({
          id:          briefingId,
          workspaceId: wsId,
          status:      'ready',
          requestedBy: 'analytics-worker',
          traceId:     uuidv7(),
          windowMs:    86_400_000,
          summary:     summaryText,
          generatedAt: Date.now(),
          createdAt:   Date.now(),
        })
        briefingsCreated++

        await emitEvent('analytics.daily-report.generated', wsId, {
          briefingId,
          date:           dateStr,
          aiRequests:     ai.totalReqs,
          totalTokens:    (ai.totalPrompt ?? 0) + (ai.totalOutput ?? 0),
          totalCostUsd:   ai.totalCost ?? 0,
          workflowRuns:   totalRuns,
          statusCounts,
          generatedAt:    Date.now(),
        })
      } catch (err) {
        log.warn({ err, wsId }, 'Failed to insert briefing')
        await emitEvent('analytics.daily-report.generated', wsId, {
          date:         dateStr,
          aiRequests:   ai.totalReqs,
          totalTokens:  (ai.totalPrompt ?? 0) + (ai.totalOutput ?? 0),
          totalCostUsd: ai.totalCost ?? 0,
          workflowRuns: totalRuns,
          statusCounts,
          generatedAt:  Date.now(),
        })
      }
    }),
  )

  log.info({ date: dateStr, workspaces: workspaceIds.length, briefingsCreated }, 'Daily reports generated')
  return { date: dateStr, workspaces: workspaceIds.length, briefingsCreated }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing analytics job')

    switch (job.name) {
      case 'aggregate-ai-usage':
        return handleAggregateAiUsage(job.data as AggregateAiUsageJob)

      case 'aggregate-workflow-metrics':
        return handleAggregateWorkflowMetrics(job.data as AggregateWorkflowMetricsJob)

      case 'cleanup-old-events':
        return handleCleanupOldEvents(job.data as CleanupOldEventsJob)

      case 'generate-daily-report':
        return handleGenerateDailyReport(job.data as GenerateDailyReportJob)

      default:
        log.warn({ jobName: job.name }, 'Unknown analytics job type')
        return { skipped: true }
    }
  },
  {
    connection,
    concurrency:     2,
    stalledInterval: 30_000,
    maxStalledCount: 2,
    lockDuration:    60_000,
  },
)

// ─── Scheduled repeat jobs ────────────────────────────────────────────────────

const analyticsQueue = new Queue(QUEUE_NAME, { connection })

async function registerScheduledJobs(): Promise<void> {
  const existing = await analyticsQueue.getRepeatableJobs()
  await Promise.all(
    existing.map((j) => analyticsQueue.removeRepeatableByKey(j.key)),
  )

  await Promise.all([
    // Aggregate AI usage every 30 minutes
    analyticsQueue.add(
      'aggregate-ai-usage',
      {},
      { repeat: { every: 30 * 60 * 1_000 }, jobId: 'scheduled-aggregate-ai-usage' },
    ),

    // Aggregate workflow metrics every hour
    analyticsQueue.add(
      'aggregate-workflow-metrics',
      {},
      { repeat: { every: 60 * 60 * 1_000 }, jobId: 'scheduled-aggregate-workflow-metrics' },
    ),

    // Cleanup old events every day at midnight
    analyticsQueue.add(
      'cleanup-old-events',
      {},
      { repeat: { pattern: '0 0 * * *' }, jobId: 'scheduled-cleanup-old-events' },
    ),

    // Generate daily report every day at 6am
    analyticsQueue.add(
      'generate-daily-report',
      {},
      { repeat: { pattern: '0 6 * * *' }, jobId: 'scheduled-generate-daily-report' },
    ),
  ])

  log.info('Scheduled analytics jobs registered')
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName: 'analytics-worker',
  queueName:  QUEUE_NAME,
  workerId:   WORKER_ID,
  log,
  emitEvent,
})

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Analytics worker shutting down')
  await cleanupLifecycle()
  await worker.close()
  await analyticsQueue.close()
  await queryClient.end()
  connection.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

registerScheduledJobs().catch((err) => {
  log.error({ err }, 'Failed to register scheduled jobs')
})

log.info({ workerId: WORKER_ID }, 'Analytics worker started')

export const WORKER_NAME = 'analytics-worker' as const
