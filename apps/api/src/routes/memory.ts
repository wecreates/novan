/**
 * Memory routes — vector memory CRUD + semantic search.
 *
 * POST   /api/v1/memory           — save memory (enqueues embedding job)
 * GET    /api/v1/memory           — list memories (paginated, filtered)
 * GET    /api/v1/memory/search    — keyword + pgvector semantic search
 * GET    /api/v1/memory/:id       — get single memory
 * PATCH  /api/v1/memory/:id       — update content/summary/tags/confidence
 * POST   /api/v1/memory/:id/mark-stale — set expiresAt = now
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                from 'zod'
import { v7 as uuidv7 }     from 'uuid'
import { db }               from '../db/client.js'
import { queues }           from '../queues/index.js'
import { memories, events } from '../db/schema.js'
import { eq, and, desc, sql, isNull, or, gt } from 'drizzle-orm'
import type { WorkspaceId } from '@ops/shared-types'
import { EVENT_TYPES, EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(
  type: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(events).values({
      id:            uuidv7(),
      type,
      workspaceId,
      payload,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'api',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     Date.now(),
    })
  } catch {
    // non-blocking
  }
}

function isStale(expiresAt: number | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined) return false
  return expiresAt < Date.now()
}

function toMemoryResponse(m: typeof memories.$inferSelect) {
  return {
    id:         m.id,
    type:       m.type,
    content:    m.content,
    ...(m.summary   !== null && m.summary   !== undefined ? { summary:   m.summary }   : {}),
    confidence: m.confidence,
    tags:       m.tags,
    source:     m.source,
    ...(m.sourceRef !== null && m.sourceRef !== undefined ? { sourceRef: m.sourceRef } : {}),
    isStale:    isStale(m.expiresAt),
    createdAt:  m.createdAt,
    updatedAt:  m.updatedAt,
    ...(m.expiresAt !== null && m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const CreateMemorySchema = z.object({
  type:       z.enum(['observation','decision','lesson','goal','idea','fact','strategic','operational']),
  content:    z.string().min(1).max(50_000),
  summary:    z.string().max(500).nullable().default(null),
  confidence: z.number().min(0).max(1).default(1.0),
  tags:       z.array(z.string()).default([]),
  source:     z.string().default('api'),
  sourceRef:  z.string().nullable().default(null),
  expiresAt:  z.number().nullable().default(null),
})

const UpdateMemorySchema = z.object({
  content:    z.string().min(1).max(50_000).optional(),
  summary:    z.string().max(500).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags:       z.array(z.string()).optional(),
  expiresAt:  z.number().nullable().optional(),
})

const SearchSchema = z.object({
  query:        z.string().min(1).max(500),
  types:        z.array(z.string()).default([]),
  tags:         z.array(z.string()).default([]),
  limit:        z.coerce.number().min(1).max(1000).default(20),
  minScore:     z.coerce.number().min(0).max(1).default(0.5),
  semantic:     z.enum(['true','false']).default('false'),
})

const ListSchema = z.object({
  type:         z.string().optional(),
  limit:        z.coerce.number().min(1).max(1000).default(20),
  includeStale: z.enum(['true','false']).default('false'),
  minConfidence: z.coerce.number().min(0).max(1).default(0),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export const memoryRoutes: FastifyPluginAsync = async (app) => {

  // POST / — create memory
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const body = CreateMemorySchema.parse(req.body)
    const now  = Date.now()
    const id   = uuidv7()

    // Duplicate check: exact content match
    const [duplicate] = await db.select({ id: memories.id })
      .from(memories)
      .where(and(
        eq(memories.workspaceId, workspaceId),
        eq(memories.content, body.content),
      ))
      .limit(1)
    const isDuplicate = !!duplicate

    const [memory] = await db.insert(memories).values({
      id,
      workspaceId,
      type:       body.type,
      content:    body.content,
      ...(body.summary   !== null ? { summary:   body.summary }   : {}),
      confidence: body.confidence,
      tags:       body.tags,
      source:     body.source,
      ...(body.sourceRef !== null ? { sourceRef: body.sourceRef } : {}),
      ...(body.expiresAt !== null ? { expiresAt: body.expiresAt } : {}),
      createdAt:  now,
      updatedAt:  now,
    }).returning()

    // Embed inline (the memory queue has no consumer; queueing leaks
    // jobs forever). Tolerates null when no embedding provider is
    // configured — memory still stored, just without vector for
    // semantic search. Fire-and-forget so the POST doesn't wait on
    // the network call. Failure is non-fatal.
    void (async () => {
      try {
        const { embedWithReason } = await import('../services/embeddings.js')
        const { memoryEmbeddings } = await import('../db/schema.js')
        const r = await embedWithReason(body.content)
        if (r.vector) {
          await db.insert(memoryEmbeddings).values({
            id:             id + ':0',
            workspaceId,
            memoryId:       id,
            chunkIndex:     0,
            chunkText:      body.content.slice(0, 8192),
            embedding:      r.vector,
            embeddingModel: 'auto',
            isStale:        false,
            createdAt:      Date.now(),
          }).catch((e: Error) => { console.error('[memory]', e.message); return null })
        }
      } catch { /* tolerated — memory still stored without embedding */ }
    })()

    // Emit event
    void emitEvent(EVENT_TYPES.MEMORY_CREATED, workspaceId, {
      memoryId:    id,
      workspaceId,
      type:        body.type,
      tags:        body.tags,
    })

    const response: Record<string, unknown> = {
      success: true,
      data:    memory !== undefined ? toMemoryResponse(memory) : null,
    }
    if (isDuplicate) response['warning'] = 'Possible duplicate detected'

    return reply.status(201).send(response)
  })

  // GET / — list memories
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const params      = ListSchema.parse(req.query)
    const now         = Date.now()

    const conditions = [eq(memories.workspaceId, workspaceId)]

    // Filter stale unless requested
    if (params.includeStale === 'false') {
      conditions.push(or(isNull(memories.expiresAt), gt(memories.expiresAt, now))!)
    }

    if (params.type !== undefined) {
      conditions.push(
        eq(memories.type, params.type as typeof memories.type._.data)
      )
    }

    if (params.minConfidence > 0) {
      conditions.push(sql`${memories.confidence} >= ${params.minConfidence}`)
    }

    const results = await db.select()
      .from(memories)
      .where(and(...conditions))
      .orderBy(desc(memories.createdAt))
      .limit(params.limit)

    return reply.send({ success: true, data: results.map(toMemoryResponse) })
  })

  // GET /search — keyword search (semantic=true enqueues a search-similar job)
  app.get('/search', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const params      = SearchSchema.parse(req.query)
    const start       = Date.now()
    const now         = Date.now()

    // Semantic search: enqueue job and return empty for async processing
    // (caller polls or uses websocket for results)
    if (params.semantic === 'true') {
      const job = await queues.memory.add('search-similar', {
        workspaceId,
        queryText: params.query,
        limit:     params.limit,
        minScore:  params.minScore,
      }, { priority: 2 })

      return reply.send({ success: true, data: [], jobId: job.id, async: true })
    }

    // Keyword search (full-text)
    const rows = await db.select()
      .from(memories)
      .where(and(
        eq(memories.workspaceId, workspaceId),
        sql`to_tsvector('english', ${memories.content}) @@ plainto_tsquery('english', ${params.query})`,
        or(isNull(memories.expiresAt), gt(memories.expiresAt, now))!,
      ))
      .orderBy(desc(memories.createdAt))
      .limit(params.limit)

    const results = rows.map(toMemoryResponse)
    const durationMs = Date.now() - start

    void emitEvent(EVENT_TYPES.MEMORY_RETRIEVAL, workspaceId, {
      workspaceId,
      count:      results.length,
      durationMs,
      query:      params.query,
    })

    return reply.send({ success: true, data: results })
  })

  // GET /:id — single memory
  app.get('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const { id }      = req.params as { id: string }

    const [mem] = await db.select()
      .from(memories)
      .where(and(
        eq(memories.id, id),
        eq(memories.workspaceId, workspaceId),
      ))
      .limit(1)

    if (!mem) return reply.status(404).send({ success: false, error: 'Not found' })
    return reply.send({ success: true, data: toMemoryResponse(mem) })
  })

  // PATCH /:id — update memory fields
  app.patch('/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const { id }      = req.params as { id: string }
    const body        = UpdateMemorySchema.parse(req.body)
    const now         = Date.now()

    const updates: Record<string, unknown> = { updatedAt: now }
    if (body.content    !== undefined) updates['content']    = body.content
    if (body.confidence !== undefined) updates['confidence'] = body.confidence
    if (body.tags       !== undefined) updates['tags']       = body.tags
    if (body.summary    !== undefined) updates['summary']    = body.summary
    if (body.expiresAt  !== undefined) updates['expiresAt']  = body.expiresAt

    const [updated] = await db.update(memories)
      .set(updates as Partial<typeof memories.$inferInsert>)
      .where(and(
        eq(memories.id, id),
        eq(memories.workspaceId, workspaceId),
      ))
      .returning()

    if (!updated) return reply.status(404).send({ success: false, error: 'Not found' })

    void emitEvent(EVENT_TYPES.MEMORY_UPDATED, workspaceId, {
      memoryId:    id,
      workspaceId,
      updatedFields: Object.keys(updates).filter((k) => k !== 'updatedAt'),
    })

    return reply.send({ success: true, data: toMemoryResponse(updated) })
  })

  // POST /:id/mark-stale — explicit stale marking
  app.post('/:id/mark-stale', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const { id }      = req.params as { id: string }
    const now         = Date.now()

    const [updated] = await db.update(memories)
      .set({ expiresAt: now, updatedAt: now })
      .where(and(
        eq(memories.id, id),
        eq(memories.workspaceId, workspaceId),
      ))
      .returning({ id: memories.id })

    if (!updated) return reply.status(404).send({ success: false, error: 'Not found' })

    void emitEvent(EVENT_TYPES.MEMORY_UPDATED, workspaceId, {
      memoryId: id, workspaceId, action: 'mark-stale',
    })

    return reply.send({ success: true })
  })
}
