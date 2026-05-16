/**
 * Memory worker — processes embedding generation and semantic search jobs.
 *
 * Job types:
 *   embed-memory      — generate and persist embedding for a memory record
 *   batch-embed       — embed multiple memory records (bulk import)
 *   search-similar    — find semantically similar memories (cosine distance)
 *   expire-memories   — find stale memories (expiresAt < now)
 *   detect-duplicates — find memories with cosine similarity > 0.95
 */
import { Worker, Queue, type Job }             from 'bullmq'
import { pino }                               from 'pino'
import { eq, and, isNotNull, lt, inArray }   from 'drizzle-orm'
import { sql }                                from 'drizzle-orm'
import { createDb, memories, events } from '@ops/db'
import { createRedisFromEnv, attachWorkerLifecycle } from '@ops/runtime-kernel'
import { EVENT_TYPES, EVENT_SCHEMA_VERSION }  from '@ops/event-contracts'
import { v7 as uuidv7 }                       from 'uuid'
import { generateEmbeddings, embedText }      from './embedder.js'
import { detectStaleMemories, generateMemoryInsights, setDb } from './intelligence.js'

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const log = pino({ name: 'memory-worker', level: process.env['LOG_LEVEL'] ?? 'info' })

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const db    = createDb(connectionString, 3)
const redis = createRedisFromEnv()

// Wire the intelligence module to the same db instance
setDb(db)

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
      source:        'memory-worker',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     Date.now(),
    })
  } catch (err) {
    log.warn({ err, type }, 'Failed to emit event')
  }
}

// ─── Job handlers ─────────────────────────────────────────────────────────────

interface EmbedMemoryJob {
  memoryId:    string
  workspaceId: string
  content:     string
}

interface BatchEmbedJob {
  workspaceId: string
  memoryIds:   string[]
}

interface SearchSimilarJob {
  workspaceId: string
  queryText:   string
  limit:       number
  minScore?:   number
}

interface ExpireMemoriesJob {
  workspaceId: string
}

interface DetectDuplicatesJob {
  workspaceId: string
  memoryId:    string
}

async function handleEmbedMemory(data: EmbedMemoryJob): Promise<{ updated: boolean }> {
  const { memoryId, workspaceId, content } = data
  const start     = Date.now()
  const embedding = await embedText(content)

  await db.update(memories)
    .set({ embedding: embedding as never, updatedAt: Date.now() })
    .where(eq(memories.id, memoryId))

  const durationMs = Date.now() - start
  log.info({ memoryId }, 'Embedding persisted')

  await emitEvent(EVENT_TYPES.MEMORY_INDEXED, workspaceId, {
    workspaceId,
    count:      1,
    durationMs,
    ...(memoryId !== undefined ? { memoryId } : {}),
  })

  return { updated: true }
}

async function handleBatchEmbed(data: BatchEmbedJob): Promise<{ processed: number }> {
  const { memoryIds, workspaceId } = data
  if (memoryIds.length === 0) return { processed: 0 }

  const start = Date.now()

  // Parameterized inArray — no sql.raw injection
  const records = await db.select({ id: memories.id, content: memories.content })
    .from(memories)
    .where(inArray(memories.id, memoryIds))

  if (records.length === 0) return { processed: 0 }

  const texts      = records.map((r) => r.content)
  const embeddings = await generateEmbeddings(texts)
  const now        = Date.now()

  const BATCH = 10
  for (let i = 0; i < records.length; i += BATCH) {
    const slice = records.slice(i, i + BATCH)
    await Promise.all(
      slice.map((rec, j) => {
        const emb = embeddings[i + j]
        if (!emb) return Promise.resolve()
        return db.update(memories)
          .set({ embedding: emb as never, updatedAt: now })
          .where(eq(memories.id, rec.id))
      }),
    )
  }

  const durationMs = Date.now() - start
  log.info({ processed: records.length }, 'Batch embedding complete')

  await emitEvent(EVENT_TYPES.MEMORY_INDEXED, workspaceId, {
    workspaceId,
    count:      records.length,
    durationMs,
  })

  return { processed: records.length }
}

async function handleSearchSimilar(
  data: SearchSimilarJob,
): Promise<{ results: { id: string; score: number; content: string }[] }> {
  const { workspaceId, queryText, limit, minScore = 0.5 } = data
  const start          = Date.now()
  const queryEmbedding = await embedText(queryText)
  const queryEmbeddingStr = `[${queryEmbedding.join(',')}]`
  const now            = Date.now()

  const rows = await db.execute<{ id: string; content: string; distance: string }>(
    sql`
      SELECT id, content, summary, confidence, source, source_ref, tags, created_at,
             (embedding <=> ${queryEmbeddingStr}::vector) AS distance
      FROM memories
      WHERE workspace_id = ${workspaceId}
        AND embedding IS NOT NULL
        AND (expires_at IS NULL OR expires_at > ${now})
      ORDER BY distance ASC
      LIMIT ${limit}
    `
  )

  const results = rows
    .map((r) => ({ id: r.id, content: r.content, score: 1 - Number(r.distance) }))
    .filter((r) => r.score >= minScore)

  const durationMs = Date.now() - start

  await emitEvent(EVENT_TYPES.MEMORY_RETRIEVAL, workspaceId, {
    workspaceId,
    count:      results.length,
    durationMs,
  })

  return { results }
}

async function handleExpireMemories(data: ExpireMemoriesJob): Promise<{ stale: number; ids: string[] }> {
  const { workspaceId } = data
  const now = Date.now()

  // Find records where expiresAt is set and in the past — return them, don't modify
  const staleRecords = await db.select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.workspaceId, workspaceId),
        isNotNull(memories.expiresAt),
        lt(memories.expiresAt, now),
      )
    )

  log.info({ stale: staleRecords.length }, 'Stale memories found')
  return { stale: staleRecords.length, ids: staleRecords.map((r) => r.id) }
}

interface AnalyzeMemoriesJob {
  workspaceId: string
}

async function handleAnalyzeMemories(
  data: AnalyzeMemoriesJob,
): Promise<{ stale: number; insights: number }> {
  const { workspaceId } = data
  const start           = Date.now()

  const [staleResult, insightResult] = await Promise.all([
    detectStaleMemories(workspaceId),
    generateMemoryInsights(workspaceId),
  ])

  const durationMs = Date.now() - start
  log.info(
    { workspaceId, stale: staleResult.totalMarked, insights: insightResult.created, durationMs },
    'Memory analysis complete',
  )

  await Promise.all([
    // Emit stale detection event if anything found
    staleResult.totalMarked > 0
      ? emitEvent(EVENT_TYPES.ANOMALY_DETECTED, workspaceId, {
          workspaceId,
          service:     'memory-worker',
          type:        'stale-memories-detected',
          severity:    staleResult.totalMarked > 50 ? 'medium' : 'low',
          description: `${staleResult.totalMarked} stale memories detected ` +
                       `(${staleResult.expiredIds.length} expired, ${staleResult.lowConfIds.length} low-confidence).`,
          metric:      'stale_memory_count',
          value:       staleResult.totalMarked,
          threshold:   0,
        })
      : Promise.resolve(),

    // Emit insight created events
    insightResult.created > 0
      ? emitEvent(EVENT_TYPES.INSIGHT_CREATED, workspaceId, {
          workspaceId,
          insightId:  'batch',
          title:      `${insightResult.created} memory insights generated`,
          category:   'memory',
          confidence: 0.8,
          timestamp:  Date.now(),
        })
      : Promise.resolve(),
  ])

  return { stale: staleResult.totalMarked, insights: insightResult.created }
}

async function handleDetectDuplicates(
  data: DetectDuplicatesJob,
): Promise<{ duplicates: string[] }> {
  const { workspaceId, memoryId } = data

  // Get the source memory's embedding
  const [source] = await db.select({ embedding: memories.embedding })
    .from(memories)
    .where(eq(memories.id, memoryId))
    .limit(1)

  if (!source?.embedding) return { duplicates: [] }

  const embeddingStr = `[${(source.embedding as number[]).join(',')}]`

  const rows = await db.execute<{ id: string }>(
    sql`
      SELECT id
      FROM memories
      WHERE workspace_id = ${workspaceId}
        AND id != ${memoryId}
        AND embedding IS NOT NULL
        AND (embedding <=> ${embeddingStr}::vector) < 0.05
      LIMIT 10
    `
  )

  const duplicates = rows.map((r) => r.id)
  log.info({ memoryId, duplicates: duplicates.length }, 'Duplicate detection complete')
  return { duplicates }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker(
  'memory',
  async (job: Job) => {
    log.info({ jobId: job.id, type: job.name }, 'Processing memory job')

    switch (job.name) {
      case 'embed-memory':
      case 'generate-embedding':
        return handleEmbedMemory(job.data as EmbedMemoryJob)

      case 'batch-embed':
        return handleBatchEmbed(job.data as BatchEmbedJob)

      case 'search-similar':
        return handleSearchSimilar(job.data as SearchSimilarJob)

      case 'expire-memories':
        return handleExpireMemories(job.data as ExpireMemoriesJob)

      case 'detect-duplicates':
        return handleDetectDuplicates(job.data as DetectDuplicatesJob)

      case 'analyze-memories':
        return handleAnalyzeMemories(job.data as AnalyzeMemoriesJob)

      default:
        log.warn({ jobName: job.name }, 'Unknown job type')
        return { skipped: true }
    }
  },
  {
    connection:  redis,
    concurrency: 4,
    limiter:     { max: 20, duration: 1_000 },
  },
)

// ─── Scheduled repeat jobs ────────────────────────────────────────────────────

const memoryQueue = new Queue('memory', { connection: redis })

async function registerScheduledJobs(): Promise<void> {
  // Idempotent: remove stale repeatable jobs before re-registering
  const existing = await memoryQueue.getRepeatableJobs()
  await Promise.all(existing.map((j) => memoryQueue.removeRepeatableByKey(j.key)))

  // Memory analysis every hour
  await memoryQueue.add(
    'analyze-memories',
    { workspaceId: process.env['DEFAULT_WORKSPACE_ID'] ?? 'default' },
    {
      repeat:            { every: 60 * 60 * 1_000 },
      jobId:             'scheduled-analyze-memories',
      removeOnComplete:  10,
      removeOnFail:      5,
    },
  )

  log.info('Scheduled memory jobs registered')
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const workerId = `memory-worker-${process.pid}`
const cleanup  = attachWorkerLifecycle(worker, {
  workerName: 'memory-worker',
  queueName:  'memory',
  workerId,
  log,
  emitEvent,
})

async function shutdown(): Promise<void> {
  await cleanup()
  await worker.close()
  await memoryQueue.close()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT',  () => { void shutdown() })

void registerScheduledJobs().catch((err) => log.error({ err }, 'Failed to register scheduled jobs'))

log.info('Memory worker started')
