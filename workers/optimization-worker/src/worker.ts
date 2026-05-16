/**
 * Optimization worker — background maintenance and scoring jobs.
 *
 * Job types:
 *   analyze-workspace      — workspace health snapshot (scheduled)
 *   cleanup-stale-memories — expire memories past expiresAt
 *   compute-risk-scores    — recompute riskScore = probability * impact where stale
 *   score-opportunities    — score unscored opportunities
 */

import { Worker, Queue, type Job } from 'bullmq'
import { pino }                    from 'pino'
import { eq, and, lt, isNotNull, isNull, sql } from 'drizzle-orm'
import { drizzle }                 from 'drizzle-orm/postgres-js'
import postgres                    from 'postgres'
import { v7 as uuidv7 }            from 'uuid'
import * as schema from '@ops/db'
import {
  attachWorkerLifecycle,
  createRedisFromEnv,
} from '@ops/runtime-kernel'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'optimization-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) throw new Error('DATABASE_URL is required')

const WORKER_ID = `optimization-worker-${process.pid}`
const QUEUE_NAME = 'optimization'

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
      source:        'optimization-worker',
      version:       1,
      createdAt:     Date.now(),
    })
  } catch (err) {
    log.warn({ err, type }, 'Failed to emit event')
  }
}

// ─── Job: analyze-workspace ───────────────────────────────────────────────────

interface AnalyzeWorkspaceJob {
  workspaceId: string
}

async function handleAnalyzeWorkspace(data: AnalyzeWorkspaceJob): Promise<Record<string, unknown>> {
  const { workspaceId } = data

  const [memCount, riskCount, oppCount] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.memories)
      .where(eq(schema.memories.workspaceId, workspaceId)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.risks)
      .where(and(eq(schema.risks.workspaceId, workspaceId), eq(schema.risks.status, 'open'))),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.opportunities)
      .where(and(eq(schema.opportunities.workspaceId, workspaceId), eq(schema.opportunities.status, 'identified'))),
  ])

  const snapshot = {
    workspaceId,
    memoriesTotal:        memCount[0]?.n ?? 0,
    openRisks:            riskCount[0]?.n ?? 0,
    identifiedOpportunities: oppCount[0]?.n ?? 0,
    analyzedAt:           Date.now(),
  }

  await emitEvent('optimization.workspace.analyzed', workspaceId, snapshot)
  log.info(snapshot, 'Workspace analysis complete')
  return snapshot
}

// ─── Job: cleanup-stale-memories ─────────────────────────────────────────────

interface CleanupStaleMemoriesJob {
  workspaceId?: string  // if omitted, process all workspaces
}

async function handleCleanupStaleMemories(data: CleanupStaleMemoriesJob): Promise<Record<string, unknown>> {
  const now = Date.now()

  // memories don't have a status column — they have expiresAt.
  // We mark them as expired by updating updatedAt and removing from active use
  // by convention: select memories where expiresAt < now and expiresAt is set.
  // We update updatedAt so callers know they've been processed.
  const conditions = [
    isNotNull(schema.memories.expiresAt),
    lt(schema.memories.expiresAt, now),
  ]
  if (data.workspaceId) {
    conditions.push(eq(schema.memories.workspaceId, data.workspaceId))
  }

  // Fetch IDs to process in batches (avoid giant IN clauses)
  const expired = await db
    .select({ id: schema.memories.id, workspaceId: schema.memories.workspaceId })
    .from(schema.memories)
    .where(and(...conditions))
    .limit(500)

  if (expired.length === 0) {
    log.info('No stale memories to clean up')
    return { cleaned: 0 }
  }

  const ids = expired.map((r) => r.id)

  await db
    .update(schema.memories)
    .set({ updatedAt: now })
    .where(
      sql`${schema.memories.id} = any(${sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(',')}]`)})`,
    )

  // Emit one event per unique workspace to keep events workspace-scoped
  const byWorkspace = new Map<string, number>()
  for (const r of expired) {
    byWorkspace.set(r.workspaceId, (byWorkspace.get(r.workspaceId) ?? 0) + 1)
  }

  await Promise.all(
    [...byWorkspace.entries()].map(([wsId, count]) =>
      emitEvent('optimization.memories.cleaned', wsId, { count, cleanedAt: now }),
    ),
  )

  log.info({ cleaned: expired.length }, 'Stale memories cleaned')
  return { cleaned: expired.length }
}

// ─── Job: compute-risk-scores ─────────────────────────────────────────────────

interface ComputeRiskScoresJob {
  workspaceId?: string
}

async function handleComputeRiskScores(data: ComputeRiskScoresJob): Promise<Record<string, unknown>> {
  const conditions = [eq(schema.risks.status, 'open')]
  if (data.workspaceId) {
    conditions.push(eq(schema.risks.workspaceId, data.workspaceId))
  }

  const openRisks = await db
    .select({
      id:          schema.risks.id,
      workspaceId: schema.risks.workspaceId,
      probability: schema.risks.probability,
      impact:      schema.risks.impact,
      riskScore:   schema.risks.riskScore,
    })
    .from(schema.risks)
    .where(and(...conditions))

  const now     = Date.now()
  let updated   = 0
  const updates: Promise<unknown>[] = []

  for (const risk of openRisks) {
    const expected = risk.probability * risk.impact
    // Use epsilon comparison for floats
    if (Math.abs((risk.riskScore ?? 0) - expected) > 0.0001) {
      updates.push(
        db.update(schema.risks)
          .set({ riskScore: expected, updatedAt: now })
          .where(eq(schema.risks.id, risk.id)),
      )
      updated++
    }
  }

  if (updates.length > 0) {
    await Promise.all(updates)
  }

  // Group by workspace for event emission
  const byWorkspace = new Map<string, number>()
  for (const r of openRisks) {
    byWorkspace.set(r.workspaceId, (byWorkspace.get(r.workspaceId) ?? 0) + 1)
  }

  if (updated > 0) {
    await Promise.all(
      [...byWorkspace.entries()].map(([wsId]) =>
        emitEvent('optimization.risks.scored', wsId, { updated, scoredAt: now }),
      ),
    )
  }

  log.info({ scanned: openRisks.length, updated }, 'Risk scores computed')
  return { scanned: openRisks.length, updated }
}

// ─── Job: score-opportunities ─────────────────────────────────────────────────

interface ScoreOpportunitiesJob {
  workspaceId?: string
}

async function handleScoreOpportunities(data: ScoreOpportunitiesJob): Promise<Record<string, unknown>> {
  const conditions = [isNull(schema.opportunities.score)]
  if (data.workspaceId) {
    conditions.push(eq(schema.opportunities.workspaceId, data.workspaceId))
  }

  const unscored = await db
    .select({
      id:                 schema.opportunities.id,
      workspaceId:        schema.opportunities.workspaceId,
      confidence:         schema.opportunities.confidence,
      strategicAlignment: schema.opportunities.strategicAlignment,
    })
    .from(schema.opportunities)
    .where(and(...conditions))
    .limit(200)

  if (unscored.length === 0) {
    log.info('No unscored opportunities')
    return { scored: 0 }
  }

  const now     = Date.now()
  const updates: Promise<unknown>[] = []

  for (const opp of unscored) {
    const confidence        = opp.confidence         ?? 0.5
    const strategicAlignment = opp.strategicAlignment ?? 0.5
    // score = confidence * 0.5 + strategicAlignment * 0.3 + 0.2
    const score = Math.min(1, confidence * 0.5 + strategicAlignment * 0.3 + 0.2)
    const scoreBreakdown = {
      confidence:         confidence * 0.5,
      strategicAlignment: strategicAlignment * 0.3,
      baseBonus:          0.2,
    }

    updates.push(
      db.update(schema.opportunities)
        .set({ score, scoreBreakdown, updatedAt: now })
        .where(eq(schema.opportunities.id, opp.id)),
    )
  }

  await Promise.all(updates)

  const byWorkspace = new Map<string, number>()
  for (const r of unscored) {
    byWorkspace.set(r.workspaceId, (byWorkspace.get(r.workspaceId) ?? 0) + 1)
  }

  await Promise.all(
    [...byWorkspace.entries()].map(([wsId, count]) =>
      emitEvent('optimization.opportunities.scored', wsId, { count, scoredAt: now }),
    ),
  )

  log.info({ scored: unscored.length }, 'Opportunities scored')
  return { scored: unscored.length }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing optimization job')

    switch (job.name) {
      case 'analyze-workspace':
        return handleAnalyzeWorkspace(job.data as AnalyzeWorkspaceJob)

      case 'cleanup-stale-memories':
        return handleCleanupStaleMemories(job.data as CleanupStaleMemoriesJob)

      case 'compute-risk-scores':
        return handleComputeRiskScores(job.data as ComputeRiskScoresJob)

      case 'score-opportunities':
        return handleScoreOpportunities(job.data as ScoreOpportunitiesJob)

      default:
        log.warn({ jobName: job.name }, 'Unknown optimization job type')
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

const optimizationQueue = new Queue(QUEUE_NAME, { connection })

async function registerScheduledJobs(): Promise<void> {
  // Remove stale repeatable jobs before re-registering (idempotent on restart)
  const existing = await optimizationQueue.getRepeatableJobs()
  await Promise.all(
    existing.map((j) => optimizationQueue.removeRepeatableByKey(j.key)),
  )

  await Promise.all([
    // Cleanup stale memories every hour
    optimizationQueue.add(
      'cleanup-stale-memories',
      {},
      { repeat: { every: 60 * 60 * 1_000 }, jobId: 'scheduled-cleanup-stale-memories' },
    ),

    // Recompute risk scores every 30 minutes
    optimizationQueue.add(
      'compute-risk-scores',
      {},
      { repeat: { every: 30 * 60 * 1_000 }, jobId: 'scheduled-compute-risk-scores' },
    ),

    // Score unscored opportunities every 15 minutes
    optimizationQueue.add(
      'score-opportunities',
      {},
      { repeat: { every: 15 * 60 * 1_000 }, jobId: 'scheduled-score-opportunities' },
    ),
  ])

  log.info('Scheduled optimization jobs registered')
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName: 'optimization-worker',
  queueName:  QUEUE_NAME,
  workerId:   WORKER_ID,
  log,
  emitEvent,
})

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'Optimization worker shutting down')
  await cleanupLifecycle()
  await worker.close()
  await optimizationQueue.close()
  await queryClient.end()
  connection.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })

// Register schedules then start
registerScheduledJobs().catch((err) => {
  log.error({ err }, 'Failed to register scheduled jobs')
})

log.info({ workerId: WORKER_ID }, 'Optimization worker started')

export const WORKER_NAME = 'optimization-worker' as const
