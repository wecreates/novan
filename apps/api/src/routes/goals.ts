import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { desc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { strategicGoals, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/goals', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[goals]', e.message); return null })
}

const StatusEnum = z.enum(['draft', 'active', 'paused', 'completed', 'abandoned'])
const HorizonEnum = z.enum(['week', 'month', 'quarter', 'year', 'multi_year'])

const KeyResultSchema = z.object({
  id: z.string(),
  title: z.string(),
  target: z.number(),
  current: z.number(),
  unit: z.string(),
})

const CreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  businessId: z.string().optional(),
  parentGoalId: z.string().optional(),
  status: StatusEnum.optional(),
  horizon: HorizonEnum.optional(),
  targetDate: z.number().int().optional(),
  progress: z.number().min(0).max(1).optional(),
  keyResults: z.array(KeyResultSchema).optional(),
  owners: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})

const UpdateSchema = CreateSchema.partial()

export const goalsRoutes: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body)
    const now = Date.now()
    const workspaceId = ws(req)
    const id = uuidv7()

    await db.insert(strategicGoals).values({
      id,
      workspaceId,
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.businessId !== undefined ? { businessId: body.businessId } : {}),
      ...(body.parentGoalId !== undefined ? { parentGoalId: body.parentGoalId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.horizon !== undefined ? { horizon: body.horizon } : {}),
      ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
      ...(body.progress !== undefined ? { progress: body.progress } : {}),
      ...(body.keyResults !== undefined ? { keyResults: body.keyResults } : {}),
      ...(body.owners !== undefined ? { owners: body.owners } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      createdAt: now,
      updatedAt: now,
    })

    const [row] = await db.select().from(strategicGoals).where(eq(strategicGoals.id, id))
    await emit('goal.created', workspaceId, { goalId: id })
    return reply.status(201).send({ success: true, data: row })
  })

  app.get('/', async (req, reply) => {
    const query = z.object({
      status: StatusEnum.optional(),
      horizon: HorizonEnum.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(30),
    }).parse(req.query)

    const conditions = [eq(strategicGoals.workspaceId, ws(req))]
    if (query.status !== undefined) conditions.push(eq(strategicGoals.status, query.status))
    if (query.horizon !== undefined) conditions.push(eq(strategicGoals.horizon, query.horizon))

    const rows = await db.select().from(strategicGoals)
      .where(and(...conditions))
      .orderBy(desc(strategicGoals.createdAt))
      .limit(query.limit)

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, ws(req))))
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' })
    return reply.send({ success: true, data: row })
  })

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateSchema.parse(req.body)
    const workspaceId = ws(req)

    const [existing] = await db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    await db.update(strategicGoals).set({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.businessId !== undefined ? { businessId: body.businessId } : {}),
      ...(body.parentGoalId !== undefined ? { parentGoalId: body.parentGoalId } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.horizon !== undefined ? { horizon: body.horizon } : {}),
      ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
      ...(body.progress !== undefined ? { progress: body.progress } : {}),
      ...(body.keyResults !== undefined ? { keyResults: body.keyResults } : {}),
      ...(body.owners !== undefined ? { owners: body.owners } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      updatedAt: Date.now(),
    }).where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))

    const [row] = await db.select().from(strategicGoals).where(eq(strategicGoals.id, id))
    await emit('goal.updated', workspaceId, { goalId: id })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const { progress } = z.object({ progress: z.number().min(0).max(1) }).parse(req.body)

    const [existing] = await db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const now = Date.now()
    const completed = progress >= 1
    await db.update(strategicGoals).set({
      progress,
      ...(completed ? { status: 'completed' as const, completedAt: now } : {}),
      updatedAt: now,
    }).where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))

    const [row] = await db.select().from(strategicGoals).where(eq(strategicGoals.id, id))
    await emit('goal.progress_updated', workspaceId, { goalId: id, progress })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const now = Date.now()
    await db.update(strategicGoals).set({ status: 'completed', completedAt: now, progress: 1, updatedAt: now })
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    const [row] = await db.select().from(strategicGoals).where(eq(strategicGoals.id, id))
    await emit('goal.completed', workspaceId, { goalId: id })
    return reply.send({ success: true, data: row })
  })

  app.post('/:id/activate', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    await db.update(strategicGoals).set({ status: 'active', updatedAt: Date.now() })
      .where(and(eq(strategicGoals.id, id), eq(strategicGoals.workspaceId, workspaceId)))
    const [row] = await db.select().from(strategicGoals).where(eq(strategicGoals.id, id))
    await emit('goal.activated', workspaceId, { goalId: id })
    return reply.send({ success: true, data: row })
  })
}
