import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { desc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { risks, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/risks', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

const CreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  probability: z.number().min(0).max(1).optional(),
  impact: z.number().min(0).max(1).optional(),
  category: z.string().optional(),
  businessId: z.string().optional(),
})

const UpdateSchema = CreateSchema.partial()

const MitigateSchema = z.object({
  description: z.string().min(1),
})

export const risksRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body)
    const probability = body.probability ?? 0.5
    const impact = body.impact ?? 0.5
    const now = Date.now()
    const workspaceId = ws(req)
    const id = uuidv7()

    await db.insert(risks).values({
      id,
      workspaceId,
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.severity !== undefined ? { severity: body.severity } : {}),
      probability,
      impact,
      riskScore: probability * impact,
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.businessId !== undefined ? { businessId: body.businessId } : {}),
      status: 'open',
      mitigations: [],
      detectedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const [row] = await db.select().from(risks).where(eq(risks.id, id))
    await emit('risk.created', workspaceId, { riskId: id })
    return reply.status(201).send({ success: true, data: row })
  })

  app.get('/', async (req, reply) => {
    const query = z.object({
      status: z.string().optional(),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(50),
    }).parse(req.query)

    const conditions = [eq(risks.workspaceId, ws(req))]
    if (query.status !== undefined) conditions.push(eq(risks.status, query.status))
    if (query.severity !== undefined) conditions.push(eq(risks.severity, query.severity))

    const rows = await db.select().from(risks)
      .where(and(...conditions))
      .orderBy(desc(risks.riskScore))
      .limit(query.limit)

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select().from(risks)
      .where(and(eq(risks.id, id), eq(risks.workspaceId, ws(req))))
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' })
    return reply.send({ success: true, data: row })
  })

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateSchema.parse(req.body)
    const workspaceId = ws(req)

    const [existing] = await db.select().from(risks)
      .where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const probability = body.probability ?? existing.probability ?? 0.5
    const impact = body.impact ?? existing.impact ?? 0.5
    const recompute = body.probability !== undefined || body.impact !== undefined

    await db.update(risks).set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.severity !== undefined ? { severity: body.severity } : {}),
      ...(body.probability !== undefined ? { probability: body.probability } : {}),
      ...(body.impact !== undefined ? { impact: body.impact } : {}),
      ...(recompute ? { riskScore: probability * impact } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.businessId !== undefined ? { businessId: body.businessId } : {}),
      updatedAt: Date.now(),
    }).where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))

    const [row] = await db.select().from(risks).where(eq(risks.id, id))
    await emit('risk.updated', workspaceId, { riskId: id })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(risks)
      .where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const now = Date.now()
    await db.update(risks).set({ status: 'resolved', resolvedAt: now, updatedAt: now })
      .where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))
    const [row] = await db.select().from(risks).where(eq(risks.id, id))
    await emit('risk.resolved', workspaceId, { riskId: id })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/mitigate', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const body = MitigateSchema.parse(req.body)

    const [existing] = await db.select().from(risks)
      .where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const newItem = { id: uuidv7(), description: body.description, addedAt: Date.now() }
    const mitigations = [...((existing.mitigations as unknown[]) ?? []), newItem]
    const now = Date.now()

    await db.update(risks).set({ mitigations, status: 'mitigating', updatedAt: now })
      .where(and(eq(risks.id, id), eq(risks.workspaceId, workspaceId)))
    const [row] = await db.select().from(risks).where(eq(risks.id, id))
    await emit('risk.mitigated', workspaceId, { riskId: id, mitigationId: newItem.id })
    return reply.send({ success: true, data: row })
  })
}
