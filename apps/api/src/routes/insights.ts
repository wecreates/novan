import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { desc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { insights, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/insights', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[insights]', e.message); return null })
}

const CreateSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  source: z.string().min(1),
  category: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceRef: z.string().optional(),
  tags: z.array(z.string()).optional(),
  expiresAt: z.number().int().optional(),
})

export const insightsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body)
    const now = Date.now()
    const workspaceId = ws(req)
    const id = uuidv7()

    await db.insert(insights).values({
      id,
      workspaceId,
      title: body.title,
      body: body.body,
      source: body.source,
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
      ...(body.sourceRef !== undefined ? { sourceRef: body.sourceRef } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      dismissed: false,
      actedOn: false,
      createdAt: now,
    })

    const [row] = await db.select().from(insights).where(eq(insights.id, id))
    await emit('insight.created', workspaceId, { insightId: id })
    return reply.status(201).send({ success: true, data: row })
  })

  app.get('/', async (req, reply) => {
    const query = z.object({
      category: z.string().optional(),
      dismissed: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(30),
    }).parse(req.query)

    const dismissedFilter = query.dismissed === 'true'
    const conditions = [
      eq(insights.workspaceId, ws(req)),
      eq(insights.dismissed, query.dismissed !== undefined ? dismissedFilter : false),
    ]
    if (query.category !== undefined) conditions.push(eq(insights.category, query.category))

    const rows = await db.select().from(insights)
      .where(and(...conditions))
      .orderBy(desc(insights.createdAt))
      .limit(query.limit)

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select().from(insights)
      .where(and(eq(insights.id, id), eq(insights.workspaceId, ws(req))))
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(insights)
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    await db.update(insights).set({ dismissed: true })
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
    const [row] = await db.select().from(insights).where(eq(insights.id, id))
    await emit('insight.dismissed', workspaceId, { insightId: id })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/act-on', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(insights)
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    await db.update(insights).set({ actedOn: true })
      .where(and(eq(insights.id, id), eq(insights.workspaceId, workspaceId)))
    const [row] = await db.select().from(insights).where(eq(insights.id, id))
    await emit('insight.acted_on', workspaceId, { insightId: id })
    return reply.send({ success: true, data: row })
  })
}
