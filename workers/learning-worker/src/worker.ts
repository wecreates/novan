/**
 * Learning worker — real signal ingestion, pattern detection, memory scoring,
 * insight generation, recommendation ranking, memory compression + decay,
 * duplicate merge, and quality score updates.
 *
 * Jobs:
 *   ingest_learning_signals   — 15 min: pull new signals from ops events
 *   detect_patterns           — 1 hr:  detect patterns from scored signals
 *   score_memories            — 1 hr:  re-score memory quality/relevance
 *   generate_insights         — 1 hr:  generate insights from patterns
 *   rank_recommendations      — 1 hr:  rank pending recommendations by evidence + feedback
 *   compress_memory           — 24 hr: compress old memory embeddings
 *   decay_stale_memory        — 24 hr: mark memories with no retrieval as stale
 *   merge_duplicates          — 24 hr: merge near-identical memory embeddings
 *   update_quality_scores     — 1 hr:  update workflow/provider/memory quality scores
 *
 * Safety: suggestions only — no silent behavior changes, no auto-execution.
 * Evidence required for every signal, pattern, insight, and recommendation.
 */
import { Worker, Queue, type Job }                        from 'bullmq'
import { pino }                                            from 'pino'
import { eq, lt, gte, and, sql, desc, not } from 'drizzle-orm'
import { drizzle }                                         from 'drizzle-orm/postgres-js'
import { v7 as uuidv7 }                                   from 'uuid'
import postgres                                            from 'postgres'
import * as schema                                         from '@ops/db'
import { startWorkerHeartbeat }                            from '@ops/db'
import { emitEvent }                                       from './events.js'
import {
  attachWorkerLifecycle,
  installProcessSafetyNet,
  createRedisFromEnv,
  QUEUE_NAMES,
  QUEUE_CONFIG,
  QUEUE_LOCK_OVERRIDES,
  type DeadLetterRecord,
} from '@ops/runtime-kernel'
import { deadLetterJobs } from '@ops/db'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'learning-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const REDIS_URL = process.env['REDIS_URL']
if (!REDIS_URL) throw new Error('REDIS_URL is required')

const WORKER_ID = `${QUEUE_NAMES.LEARNING}-worker-${process.pid}`

const queryClient   = postgres(connectionString, { max: 4, idle_timeout: 30 })
const db            = drizzle(queryClient)
startWorkerHeartbeat({ db, name: 'learning-worker', capabilities: ['pattern-detection', 'signal-ingest', 'memory-scoring'] })
const connection    = createRedisFromEnv()
const learningQueue = new Queue(QUEUE_NAMES.LEARNING, { connection })

// ─── Ollama Embedder ──────────────────────────────────────────────────────────

const OLLAMA_URL   = process.env['OLLAMA_URL'] ?? 'http://localhost:11434'
const EMBED_MODEL  = process.env['LEARNING_EMBED_MODEL'] ?? 'nomic-embed-text'

async function embedText(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    })
    if (!resp.ok) return null
    const json = await resp.json() as { embedding?: number[] }
    return json.embedding ?? null
  } catch {
    return null
  }
}

// ─── Signal Ingestion ─────────────────────────────────────────────────────────
// Pull real ops events and convert to learning signals.
// Sources: workflow_runs, dead_letter_jobs, approvals, recovery_log, events

async function ingestLearningSignals(workspaceId?: string): Promise<{ ingested: number }> {
  const since = Date.now() - 15 * 60 * 1_000  // last 15 min
  const now   = Date.now()
  let ingested = 0

  // 1. Workflow failures
  const failedRuns = await db
    .select({
      id:           schema.workflowRuns.id,
      workspaceId:  schema.workflowRuns.workspaceId,
      workflowId:   schema.workflowRuns.workflowId,
      errorMessage: schema.workflowRuns.errorMessage,
      attempt:      schema.workflowRuns.attempt,
      failedAt:     schema.workflowRuns.failedAt,
    })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.status, 'failed'),
        gte(schema.workflowRuns.failedAt, since),
        ...(workspaceId ? [eq(schema.workflowRuns.workspaceId, workspaceId)] : []),
      )
    )
    .limit(200)

  for (const run of failedRuns) {
    await db.insert(schema.learningSignals).values({
      id:               uuidv7(),
      workspaceId:      run.workspaceId,
      source:           'workflow_failure',
      sourceRunId:      run.id,
      sourceWorkflowId: run.workflowId,
      signal:           'workflow_failed',
      evidence:         { runId: run.id, workflowId: run.workflowId, attempt: run.attempt, error: run.errorMessage },
      confidence:       1.0,
      status:           'new',
      reviewRequired:   false,
      createdAt:        now,
      updatedAt:        now,
    }).onConflictDoNothing()
    ingested++
  }

  // 2. Workflow successes
  const successRuns = await db
    .select({
      id:          schema.workflowRuns.id,
      workspaceId: schema.workflowRuns.workspaceId,
      workflowId:  schema.workflowRuns.workflowId,
      completedAt: schema.workflowRuns.completedAt,
      startedAt:   schema.workflowRuns.startedAt,
      attempt:     schema.workflowRuns.attempt,
    })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.status, 'completed'),
        gte(schema.workflowRuns.completedAt, since),
        ...(workspaceId ? [eq(schema.workflowRuns.workspaceId, workspaceId)] : []),
      )
    )
    .limit(200)

  for (const run of successRuns) {
    const durationMs = run.completedAt && run.startedAt ? run.completedAt - run.startedAt : null
    await db.insert(schema.learningSignals).values({
      id:               uuidv7(),
      workspaceId:      run.workspaceId,
      source:           'workflow_success',
      sourceRunId:      run.id,
      sourceWorkflowId: run.workflowId,
      signal:           'workflow_completed',
      evidence:         { runId: run.id, workflowId: run.workflowId, durationMs, attempt: run.attempt },
      confidence:       1.0,
      status:           'new',
      reviewRequired:   false,
      createdAt:        now,
      updatedAt:        now,
    }).onConflictDoNothing()
    ingested++
  }

  // 3. Dead-letter jobs
  const dlqJobs = await db
    .select({
      id:          schema.deadLetterJobs.id,
      workspaceId: schema.deadLetterJobs.workspaceId,
      queueName:   schema.deadLetterJobs.queueName,
      jobName:     schema.deadLetterJobs.jobName,
      error:       schema.deadLetterJobs.error,
      attempts:    schema.deadLetterJobs.attempts,
    })
    .from(schema.deadLetterJobs)
    .where(
      and(
        gte(schema.deadLetterJobs.deadLetteredAt, since),
        ...(workspaceId ? [eq(schema.deadLetterJobs.workspaceId, workspaceId)] : []),
      )
    )
    .limit(100)

  for (const job of dlqJobs) {
    await db.insert(schema.learningSignals).values({
      id:           uuidv7(),
      workspaceId:  job.workspaceId,
      source:       'dlq',
      signal:       'job_dead_lettered',
      evidence:     { jobId: job.id, queue: job.queueName, jobName: job.jobName, error: job.error, attempts: job.attempts },
      confidence:   1.0,
      status:       'new',
      reviewRequired: false,
      createdAt:    now,
      updatedAt:    now,
    }).onConflictDoNothing()
    ingested++
  }

  // 4. Expired approvals (approval friction signal)
  const expiredApprovals = await db
    .select({
      id:          schema.approvals.id,
      workspaceId: schema.approvals.workspaceId,
      runId:       schema.approvals.runId,
      resolvedAt:  schema.approvals.resolvedAt,
    })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.status, 'expired'),
        gte(schema.approvals.resolvedAt, since),
        ...(workspaceId ? [eq(schema.approvals.workspaceId, workspaceId)] : []),
      )
    )
    .limit(100)

  for (const appr of expiredApprovals) {
    await db.insert(schema.learningSignals).values({
      id:          uuidv7(),
      workspaceId: appr.workspaceId,
      source:      'approval',
      signal:      'approval_expired',
      evidence:    { approvalId: appr.id, runId: appr.runId },
      confidence:  1.0,
      status:      'new',
      reviewRequired: false,
      createdAt:   now,
      updatedAt:   now,
    }).onConflictDoNothing()
    ingested++
  }

  if (ingested > 0) {
    await emitEvent('learning.signal.created', workspaceId ?? 'system', { count: ingested, windowMs: 15 * 60 * 1_000 })
  }

  log.info({ ingested }, 'ingest_learning_signals complete')
  return { ingested }
}

// ─── Pattern Detection ────────────────────────────────────────────────────────
// Analyzes scored signals to detect actionable patterns.

async function detectPatterns(workspaceId?: string): Promise<{ detected: number }> {
  const window = Date.now() - 24 * 60 * 60 * 1_000  // 24h window
  const now    = Date.now()
  let detected = 0

  // Mark signals as scored (processing them for patterns)
  await db.update(schema.learningSignals)
    .set({ status: 'scored', updatedAt: now })
    .where(
      and(
        eq(schema.learningSignals.status, 'new'),
        gte(schema.learningSignals.createdAt, window),
        ...(workspaceId ? [eq(schema.learningSignals.workspaceId, workspaceId)] : []),
      )
    )

  // Pattern 1: Repeated workflow failures (same workflowId, >=3 failures in 24h)
  const failureCounts = await db
    .select({
      workspaceId:  schema.learningSignals.workspaceId,
      workflowId:   schema.learningSignals.sourceWorkflowId,
      count:        sql<number>`count(*)::int`,
    })
    .from(schema.learningSignals)
    .where(
      and(
        eq(schema.learningSignals.source, 'workflow_failure'),
        gte(schema.learningSignals.createdAt, window),
        ...(workspaceId ? [eq(schema.learningSignals.workspaceId, workspaceId)] : []),
      )
    )
    .groupBy(schema.learningSignals.workspaceId, schema.learningSignals.sourceWorkflowId)

  for (const row of failureCounts) {
    if (!row.workflowId || row.count < 3) continue

    // Check if pattern already exists
    const existing = await db
      .select({ id: schema.learningPatterns.id, occurrences: schema.learningPatterns.occurrences })
      .from(schema.learningPatterns)
      .where(
        and(
          eq(schema.learningPatterns.workspaceId, row.workspaceId),
          eq(schema.learningPatterns.patternType, 'repeated_failure'),
          eq(schema.learningPatterns.status, 'active'),
          sql`${schema.learningPatterns.evidence}::jsonb @> ${JSON.stringify([{ workflowId: row.workflowId }])}::jsonb`,
        )
      )
      .limit(1)

    if (existing.length > 0) {
      await db.update(schema.learningPatterns)
        .set({ occurrences: row.count, lastSeenAt: now, updatedAt: now })
        .where(eq(schema.learningPatterns.id, existing[0]!.id))
    } else {
      const confidence = Math.min(0.5 + row.count * 0.1, 0.95)
      await db.insert(schema.learningPatterns).values({
        id:          uuidv7(),
        workspaceId: row.workspaceId,
        patternType: 'repeated_failure',
        title:       `Workflow failing repeatedly (${row.count}x in 24h)`,
        description: `Workflow ${row.workflowId} has failed ${row.count} times in the last 24 hours.`,
        occurrences: row.count,
        confidence,
        evidence:    [{ workflowId: row.workflowId, failureCount: row.count, windowMs: 24 * 3600_000 }],
        affectedIds: [row.workflowId],
        status:      'active',
        firstSeenAt: now,
        lastSeenAt:  now,
        createdAt:   now,
        updatedAt:   now,
      })
      detected++
    }
  }

  // Pattern 2: DLQ accumulation (>=5 dead-letter jobs in 24h)
  const dlqCounts = await db
    .select({
      workspaceId: schema.learningSignals.workspaceId,
      count:       sql<number>`count(*)::int`,
    })
    .from(schema.learningSignals)
    .where(
      and(
        eq(schema.learningSignals.source, 'dlq'),
        gte(schema.learningSignals.createdAt, window),
        ...(workspaceId ? [eq(schema.learningSignals.workspaceId, workspaceId)] : []),
      )
    )
    .groupBy(schema.learningSignals.workspaceId)

  for (const row of dlqCounts) {
    if (row.count < 5) continue
    const existing = await db
      .select({ id: schema.learningPatterns.id })
      .from(schema.learningPatterns)
      .where(
        and(
          eq(schema.learningPatterns.workspaceId, row.workspaceId),
          eq(schema.learningPatterns.patternType, 'recurring_bottleneck'),
          gte(schema.learningPatterns.createdAt, window),
          eq(schema.learningPatterns.status, 'active'),
        )
      )
      .limit(1)

    if (existing.length === 0) {
      await db.insert(schema.learningPatterns).values({
        id:          uuidv7(),
        workspaceId: row.workspaceId,
        patternType: 'recurring_bottleneck',
        title:       `DLQ accumulation (${row.count} jobs in 24h)`,
        description: `${row.count} jobs have dead-lettered in the last 24 hours — likely a systemic queue processing issue.`,
        occurrences: row.count,
        confidence:  Math.min(0.4 + row.count * 0.05, 0.9),
        evidence:    [{ dlqCount: row.count, windowMs: 24 * 3600_000 }],
        affectedIds: [],
        status:      'active',
        firstSeenAt: now,
        lastSeenAt:  now,
        createdAt:   now,
        updatedAt:   now,
      })
      detected++
    }
  }

  // Pattern 3: Approval friction (>=3 expired approvals)
  const approvalCounts = await db
    .select({
      workspaceId: schema.learningSignals.workspaceId,
      count:       sql<number>`count(*)::int`,
    })
    .from(schema.learningSignals)
    .where(
      and(
        eq(schema.learningSignals.signal, 'approval_expired'),
        gte(schema.learningSignals.createdAt, window),
        ...(workspaceId ? [eq(schema.learningSignals.workspaceId, workspaceId)] : []),
      )
    )
    .groupBy(schema.learningSignals.workspaceId)

  for (const row of approvalCounts) {
    if (row.count < 3) continue
    const existing = await db
      .select({ id: schema.learningPatterns.id })
      .from(schema.learningPatterns)
      .where(
        and(
          eq(schema.learningPatterns.workspaceId, row.workspaceId),
          eq(schema.learningPatterns.patternType, 'approval_friction'),
          gte(schema.learningPatterns.createdAt, window),
          eq(schema.learningPatterns.status, 'active'),
        )
      )
      .limit(1)

    if (existing.length === 0) {
      await db.insert(schema.learningPatterns).values({
        id:          uuidv7(),
        workspaceId: row.workspaceId,
        patternType: 'approval_friction',
        title:       `Approval bottleneck (${row.count} expired in 24h)`,
        description: `${row.count} approval requests expired without action. Approvers may be overloaded or notifications not reaching them.`,
        occurrences: row.count,
        confidence:  Math.min(0.5 + row.count * 0.1, 0.9),
        evidence:    [{ expiredCount: row.count, windowMs: 24 * 3600_000 }],
        affectedIds: [],
        status:      'active',
        firstSeenAt: now,
        lastSeenAt:  now,
        createdAt:   now,
        updatedAt:   now,
      })
      detected++
    }
  }

  if (detected > 0) {
    await emitEvent('learning.pattern.detected', workspaceId ?? 'system', { count: detected })
  }

  log.info({ detected }, 'detect_patterns complete')
  return { detected }
}

// ─── Memory Scoring ───────────────────────────────────────────────────────────
// Score memory relevance based on retrieval frequency + age + confidence.

async function scoreMemories(workspaceId?: string, limit = 500): Promise<{ scored: number }> {
  const now    = Date.now()
  let scored   = 0

  const memories = await db
    .select({
      id:          schema.memories.id,
      workspaceId: schema.memories.workspaceId,
      confidence:  schema.memories.confidence,
      createdAt:   schema.memories.createdAt,
      updatedAt:   schema.memories.updatedAt,
    })
    .from(schema.memories)
    .where(
      workspaceId ? eq(schema.memories.workspaceId, workspaceId) : undefined
    )
    .orderBy(desc(schema.memories.updatedAt))
    .limit(limit)

  for (const mem of memories) {
    // Count retrievals
    const retrievalCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.retrievalLogs)
      .where(
        and(
          eq(schema.retrievalLogs.workspaceId, mem.workspaceId),
          sql`${schema.retrievalLogs.memoryIdsReturned}::jsonb @> ${JSON.stringify([mem.id])}::jsonb`,
          gte(schema.retrievalLogs.createdAt, now - 7 * 24 * 3600_000),
        )
      )
      .then((r) => r[0]?.count ?? 0)

    const ageMs     = now - mem.createdAt
    const ageDays   = ageMs / 86_400_000
    const agePenalty = Math.max(0, 1 - ageDays / 90)  // decay over 90 days
    const retrievalBonus = Math.min(retrievalCount * 0.1, 0.3)
    const scoreValue = Math.max(0.1, mem.confidence * agePenalty + retrievalBonus)

    // Upsert quality score
    const existingScore = await db
      .select({ id: schema.learningScores.id, history: schema.learningScores.history })
      .from(schema.learningScores)
      .where(
        and(
          eq(schema.learningScores.workspaceId, mem.workspaceId),
          eq(schema.learningScores.entityType, 'memory'),
          eq(schema.learningScores.entityId, mem.id),
          eq(schema.learningScores.scoreType, 'relevance'),
        )
      )
      .limit(1)

    if (existingScore.length > 0) {
      const history = (existingScore[0]!.history as Array<{ts: number; value: number}>) ?? []
      history.push({ ts: now, value: scoreValue })
      if (history.length > 30) history.splice(0, history.length - 30)
      await db.update(schema.learningScores)
        .set({ scoreValue, history, sampleCount: sql`${schema.learningScores.sampleCount} + 1`, updatedAt: now })
        .where(eq(schema.learningScores.id, existingScore[0]!.id))
    } else {
      await db.insert(schema.learningScores).values({
        id:          uuidv7(),
        workspaceId: mem.workspaceId,
        entityType:  'memory',
        entityId:    mem.id,
        scoreType:   'relevance',
        scoreValue,
        history:     [{ ts: now, value: scoreValue }],
        sampleCount: 1,
        createdAt:   now,
        updatedAt:   now,
      })
    }
    scored++
  }

  log.info({ scored }, 'score_memories complete')
  return { scored }
}

// ─── Insight Generation ───────────────────────────────────────────────────────
// Generate insights from active patterns. Never auto-executes — creates pending_review items.

async function generateInsights(workspaceId?: string): Promise<{ generated: number }> {
  const now   = Date.now()
  let generated = 0

  const patterns = await db
    .select()
    .from(schema.learningPatterns)
    .where(
      and(
        eq(schema.learningPatterns.status, 'active'),
        ...(workspaceId ? [eq(schema.learningPatterns.workspaceId, workspaceId)] : []),
      )
    )
    .orderBy(desc(schema.learningPatterns.confidence))
    .limit(50)

  for (const pattern of patterns) {
    // Check if insight already exists for this pattern
    const existing = await db
      .select({ id: schema.learningInsights.id })
      .from(schema.learningInsights)
      .where(
        and(
          eq(schema.learningInsights.workspaceId, pattern.workspaceId),
          eq(schema.learningInsights.patternId, pattern.id),
          not(eq(schema.learningInsights.status, 'archived')),
        )
      )
      .limit(1)

    if (existing.length > 0) continue  // insight already exists

    const { title, body, category, actionRequired } = buildInsightFromPattern(pattern)

    // Generate embedding for the insight body
    const embedding = await embedText(`${title}\n${body}`)

    await db.insert(schema.learningInsights).values({
      id:             uuidv7(),
      workspaceId:    pattern.workspaceId,
      title,
      body,
      category,
      confidence:     pattern.confidence,
      evidence:       pattern.evidence as Record<string, unknown>[],
      actionRequired,
      approved:       null,  // requires human review
      patternId:      pattern.id,
      embedding:      embedding as unknown as number[],
      status:         'pending_review',
      createdAt:      now,
      updatedAt:      now,
    })
    generated++
  }

  if (generated > 0) {
    await emitEvent('learning.insight.created', workspaceId ?? 'system', { count: generated })
  }

  log.info({ generated }, 'generate_insights complete')
  return { generated }
}

function buildInsightFromPattern(pattern: typeof schema.learningPatterns.$inferSelect): {
  title: string; body: string; category: string; actionRequired: boolean
} {
  switch (pattern.patternType) {
    case 'repeated_failure':
      return {
        title: `Workflow reliability issue: ${pattern.title}`,
        body:  `${pattern.description} This may indicate a systemic problem with the workflow configuration, external dependency failure, or resource constraint. Evidence: ${JSON.stringify(pattern.evidence)}`,
        category: 'reliability',
        actionRequired: pattern.occurrences >= 5,
      }
    case 'approval_friction':
      return {
        title: `Approval process bottleneck detected`,
        body:  `${pattern.description} Consider reviewing notification delivery, approval deadlines, or automating low-risk approvals. Evidence: ${JSON.stringify(pattern.evidence)}`,
        category: 'operational',
        actionRequired: true,
      }
    case 'recurring_bottleneck':
      return {
        title: `Queue health issue: ${pattern.title}`,
        body:  `${pattern.description} Dead-lettered jobs require investigation. Check worker health, queue configuration, and error logs. Evidence: ${JSON.stringify(pattern.evidence)}`,
        category: 'reliability',
        actionRequired: true,
      }
    default:
      return {
        title: pattern.title,
        body:  `${pattern.description} Evidence: ${JSON.stringify(pattern.evidence)}`,
        category: 'operational',
        actionRequired: false,
      }
  }
}

// ─── Recommendation Ranking ───────────────────────────────────────────────────
// Score and rank pending recommendations based on evidence + feedback history.

async function rankRecommendations(workspaceId?: string): Promise<{ ranked: number }> {
  const now   = Date.now()
  let ranked  = 0

  // Get approved insights that need recommendations
  const insights = await db
    .select()
    .from(schema.learningInsights)
    .where(
      and(
        eq(schema.learningInsights.status, 'approved'),
        ...(workspaceId ? [eq(schema.learningInsights.workspaceId, workspaceId)] : []),
      )
    )
    .limit(50)

  for (const insight of insights) {
    // Get feedback for similar insights to calibrate score
    const feedbackRows = await db
      .select({ action: schema.learningFeedback.action, outcome: schema.learningFeedback.outcome })
      .from(schema.learningFeedback)
      .where(eq(schema.learningFeedback.workspaceId, insight.workspaceId))
      .limit(100)

    const successRate = feedbackRows.length === 0
      ? 0.5
      : feedbackRows.filter((f) => f.outcome === 'successful').length / feedbackRows.length

    // Update the score
    const existing = await db
      .select({ id: schema.learningScores.id })
      .from(schema.learningScores)
      .where(
        and(
          eq(schema.learningScores.entityType, 'insight'),
          eq(schema.learningScores.entityId, insight.id),
          eq(schema.learningScores.scoreType, 'quality'),
        )
      )
      .limit(1)

    const scoreValue = insight.confidence * 0.6 + successRate * 0.4

    if (existing.length > 0) {
      await db.update(schema.learningScores)
        .set({ scoreValue, sampleCount: sql`${schema.learningScores.sampleCount} + 1`, updatedAt: now })
        .where(eq(schema.learningScores.id, existing[0]!.id))
    } else {
      await db.insert(schema.learningScores).values({
        id:          uuidv7(),
        workspaceId: insight.workspaceId,
        entityType:  'insight',
        entityId:    insight.id,
        scoreType:   'quality',
        scoreValue,
        history:     [{ ts: now, value: scoreValue }],
        sampleCount: 1,
        createdAt:   now,
        updatedAt:   now,
      })
    }
    ranked++
  }

  log.info({ ranked }, 'rank_recommendations complete')
  return { ranked }
}

// ─── Memory Compression ───────────────────────────────────────────────────────
// Generate embeddings for memories that don't have them yet.

async function compressMemory(workspaceId?: string): Promise<{ compressed: number }> {
  const now   = Date.now()
  let compressed = 0

  // Find memories without embeddings in memory_embeddings
  const memoriesWithoutEmbeddings = await db
    .select({ id: schema.memories.id, workspaceId: schema.memories.workspaceId, content: schema.memories.content })
    .from(schema.memories)
    .where(
      and(
        ...(workspaceId ? [eq(schema.memories.workspaceId, workspaceId)] : []),
        sql`NOT EXISTS (SELECT 1 FROM memory_embeddings WHERE memory_id = ${schema.memories.id})`,
      )
    )
    .limit(50)  // batch of 50 per run

  for (const mem of memoriesWithoutEmbeddings) {
    const embedding = await embedText(mem.content)
    if (!embedding) continue

    await db.insert(schema.memoryEmbeddings).values({
      id:             uuidv7(),
      workspaceId:    mem.workspaceId,
      memoryId:       mem.id,
      chunkIndex:     0,
      chunkText:      mem.content.slice(0, 2000),
      embedding:      embedding as unknown as number[],
      embeddingModel: EMBED_MODEL,
      isStale:        false,
      createdAt:      now,
    }).onConflictDoNothing()
    compressed++
  }

  log.info({ compressed }, 'compress_memory complete')
  return { compressed }
}

// ─── Stale Memory Decay ───────────────────────────────────────────────────────
// Mark memory embeddings as stale if the memory hasn't been retrieved in 30 days.

async function decayStaleMemory(workspaceId?: string): Promise<{ decayed: number }> {
  const staleThreshold = Date.now() - 30 * 24 * 3600_000

  const result = await db.update(schema.memoryEmbeddings)
    .set({ isStale: true })
    .where(
      and(
        eq(schema.memoryEmbeddings.isStale, false),
        lt(schema.memoryEmbeddings.createdAt, staleThreshold),
        ...(workspaceId ? [eq(schema.memoryEmbeddings.workspaceId, workspaceId)] : []),
      )
    )
    .returning({ id: schema.memoryEmbeddings.id })

  const decayed = result.length
  log.info({ decayed }, 'decay_stale_memory complete')
  return { decayed }
}

// ─── Duplicate Merge ──────────────────────────────────────────────────────────
// Detect near-duplicate patterns (same type, same workspaceId, similar title).

async function mergeDuplicates(workspaceId?: string): Promise<{ merged: number }> {
  const now  = Date.now()
  let merged = 0

  // Find duplicate patterns: same type + workspaceId + very similar evidence
  const activePatterns = await db
    .select()
    .from(schema.learningPatterns)
    .where(
      and(
        eq(schema.learningPatterns.status, 'active'),
        ...(workspaceId ? [eq(schema.learningPatterns.workspaceId, workspaceId)] : []),
      )
    )
    .orderBy(schema.learningPatterns.createdAt)

  const seen = new Map<string, string>()  // key -> id of canonical pattern

  for (const pattern of activePatterns) {
    const key = `${pattern.workspaceId}:${pattern.patternType}:${JSON.stringify(pattern.affectedIds).slice(0, 100)}`
    if (seen.has(key)) {
      // Merge: supersede this one, add occurrences to canonical
      const canonicalId = seen.get(key)!
      await db.update(schema.learningPatterns)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(schema.learningPatterns.id, pattern.id))
      await db.update(schema.learningPatterns)
        .set({
          occurrences: sql`${schema.learningPatterns.occurrences} + ${pattern.occurrences}`,
          lastSeenAt:  Math.max(pattern.lastSeenAt, now),
          updatedAt:   now,
        })
        .where(eq(schema.learningPatterns.id, canonicalId))
      merged++
    } else {
      seen.set(key, pattern.id)
    }
  }

  log.info({ merged }, 'merge_duplicates complete')
  return { merged }
}

// ─── Quality Score Updates ────────────────────────────────────────────────────
// Update workflow + provider quality scores based on recent signals.

async function updateQualityScores(workspaceId?: string): Promise<{ updated: number }> {
  const now    = Date.now()
  const window = now - 24 * 3600_000
  let updated  = 0

  // Workflow quality: ratio of successes to (successes + failures)
  const wfStats = await db
    .select({
      workspaceId:  schema.workflowRuns.workspaceId,
      workflowId:   schema.workflowRuns.workflowId,
      total:        sql<number>`count(*)::int`,
      completed:    sql<number>`sum(case when status='completed' then 1 else 0 end)::int`,
      failed:       sql<number>`sum(case when status='failed' then 1 else 0 end)::int`,
    })
    .from(schema.workflowRuns)
    .where(
      and(
        gte(schema.workflowRuns.triggeredAt, window),
        ...(workspaceId ? [eq(schema.workflowRuns.workspaceId, workspaceId)] : []),
      )
    )
    .groupBy(schema.workflowRuns.workspaceId, schema.workflowRuns.workflowId)
    .limit(200)

  for (const stat of wfStats) {
    if (!stat.workflowId || stat.total < 2) continue
    const scoreValue = stat.completed / stat.total

    const existing = await db
      .select({ id: schema.learningScores.id, history: schema.learningScores.history })
      .from(schema.learningScores)
      .where(
        and(
          eq(schema.learningScores.workspaceId, stat.workspaceId),
          eq(schema.learningScores.entityType, 'workflow'),
          eq(schema.learningScores.entityId, stat.workflowId),
          eq(schema.learningScores.scoreType, 'reliability'),
        )
      )
      .limit(1)

    if (existing.length > 0) {
      const history = (existing[0]!.history as Array<{ts: number; value: number}>) ?? []
      history.push({ ts: now, value: scoreValue })
      if (history.length > 30) history.splice(0, history.length - 30)
      await db.update(schema.learningScores)
        .set({ scoreValue, history, sampleCount: stat.total, updatedAt: now })
        .where(eq(schema.learningScores.id, existing[0]!.id))
    } else {
      await db.insert(schema.learningScores).values({
        id:          uuidv7(),
        workspaceId: stat.workspaceId,
        entityType:  'workflow',
        entityId:    stat.workflowId,
        scoreType:   'reliability',
        scoreValue,
        history:     [{ ts: now, value: scoreValue }],
        sampleCount: stat.total,
        createdAt:   now,
        updatedAt:   now,
      })
    }
    updated++
  }

  // Emit executive summary daily
  await emitEvent('learning.quality_scores.updated', workspaceId ?? 'system', { updated, windowMs: window })

  log.info({ updated }, 'update_quality_scores complete')
  return { updated }
}

// ─── Scheduled repeat job registration ───────────────────────────────────────

async function registerScheduledJobs(): Promise<void> {
  const jobs: Array<{ name: string; every: number }> = [
    { name: 'ingest_learning_signals',  every: 15 * 60 * 1_000 },       // 15 min
    { name: 'detect_patterns',          every: 60 * 60 * 1_000 },       // 1 hr
    { name: 'score_memories',           every: 60 * 60 * 1_000 },       // 1 hr
    { name: 'generate_insights',        every: 60 * 60 * 1_000 },       // 1 hr
    { name: 'rank_recommendations',     every: 60 * 60 * 1_000 },       // 1 hr
    { name: 'update_quality_scores',    every: 60 * 60 * 1_000 },       // 1 hr
    { name: 'compress_memory',          every: 24 * 60 * 60 * 1_000 },  // 24 hr
    { name: 'decay_stale_memory',       every: 24 * 60 * 60 * 1_000 },  // 24 hr
    { name: 'merge_duplicates',         every: 24 * 60 * 60 * 1_000 },  // 24 hr
  ]

  for (const { name, every } of jobs) {
    await learningQueue.add(name, {}, {
      repeat:           { every },
      jobId:            `scheduled:${name}`,
      removeOnComplete: { count: 5 },
      removeOnFail:     { count: 10 },
    })
    log.info({ name, everyMs: every }, 'Scheduled job registered')
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  QUEUE_NAMES.LEARNING,
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing learning job')

    switch (job.name) {
      case 'ingest_learning_signals':
        return ingestLearningSignals(job.data?.workspaceId)
      case 'detect_patterns':
        return detectPatterns(job.data?.workspaceId)
      case 'score_memories':
        return scoreMemories(job.data?.workspaceId, job.data?.limit)
      case 'generate_insights':
        return generateInsights(job.data?.workspaceId)
      case 'rank_recommendations':
        return rankRecommendations(job.data?.workspaceId)
      case 'compress_memory':
        return compressMemory(job.data?.workspaceId)
      case 'decay_stale_memory':
        return decayStaleMemory(job.data?.workspaceId)
      case 'merge_duplicates':
        return mergeDuplicates(job.data?.workspaceId)
      case 'update_quality_scores':
        return updateQualityScores(job.data?.workspaceId)
      default:
        log.warn({ jobName: job.name }, 'Unknown learning job type')
        return { skipped: true }
    }
  },
  {
    connection,
    concurrency:     2,
    stalledInterval: QUEUE_CONFIG.STALL_INTERVAL_MS,
    maxStalledCount: QUEUE_CONFIG.MAX_STALL_COUNT,
    lockDuration:    QUEUE_LOCK_OVERRIDES[QUEUE_NAMES.LEARNING] ?? QUEUE_CONFIG.LOCK_DURATION_MS,
  },
)

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const cleanupLifecycle = attachWorkerLifecycle(worker, {
  workerName:  'learning-worker',
  queueName:   QUEUE_NAMES.LEARNING,
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
    log.warn({ jobId: record.jobId, error: record.error }, 'Learning job dead-lettered')
  },
})

// ─── Graceful shutdown ─────────────────────────────────────────────────────────

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'Learning worker shutting down')
  await cleanupLifecycle()
  await worker.close()
  await learningQueue.close()
  await queryClient.end()
  connection.disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT',  () => { void shutdown('SIGINT') })
installProcessSafetyNet({ workerName: 'learning-worker', log })

// ─── Startup ──────────────────────────────────────────────────────────────────

void registerScheduledJobs().then(() => {
  log.info({ workerId: WORKER_ID }, 'Learning worker started')
}).catch((err: unknown) => {
  log.error({ err }, 'Failed to register scheduled jobs')
  process.exit(1)
})
