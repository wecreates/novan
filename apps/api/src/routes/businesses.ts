/**
 * Business routes — manage tracked businesses (prospects, clients, portfolio).
 *
 * POST /api/v1/businesses               — create
 * GET  /api/v1/businesses               — list
 * GET  /api/v1/businesses/:id           — detail
 * PUT  /api/v1/businesses/:id           — update
 * POST /api/v1/businesses/:id/metrics   — merge metrics
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { asc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/businesses', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

const Stage = z.enum(['early', 'growth', 'scale', 'enterprise'])
const Health = z.enum(['green', 'yellow', 'red'])

const CreateBody = z.object({
  name: z.string().min(1).max(300),
  domain: z.string().max(500).optional(),
  industry: z.string().max(200).optional(),
  stage: Stage.optional(),
  health: Health.optional(),
  metrics: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(300).optional(),
  domain: z.string().max(500).optional(),
  industry: z.string().max(200).optional(),
  stage: Stage.optional(),
  health: Health.optional(),
  metrics: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
})

const MetricsBody = z.object({
  metrics: z.record(z.unknown()),
})

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(20),
})

export const businessesRoutes: FastifyPluginAsync = async (app) => {
  // POST / — create
  app.post('/', async (req, reply) => {
    const body = CreateBody.parse(req.body)
    const workspaceId = ws(req)
    const now = Date.now()
    const id = uuidv7()

    await db.insert(businesses).values({
      id,
      workspaceId,
      name: body.name,
      ...(body.domain !== undefined ? { domain: body.domain } : {}),
      ...(body.industry !== undefined ? { industry: body.industry } : {}),
      stage: body.stage ?? 'early',
      health: body.health ?? 'green',
      metrics: (body.metrics ?? {}) as Record<string, unknown>,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    })

    const [business] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1)
    await emit('business.created', workspaceId, { businessId: id, name: body.name })

    return reply.code(201).send({ success: true, data: business })
  })

  // GET / — list
  app.get('/', async (req, reply) => {
    const { limit } = ListQuery.parse(req.query)
    const workspaceId = ws(req)

    const rows = await db.select().from(businesses)
      .where(eq(businesses.workspaceId, workspaceId))
      .orderBy(asc(businesses.name))
      .limit(limit)

    return reply.send({ success: true, data: rows })
  })

  // GET /:id — detail
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)

    const [business] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!business) return reply.code(404).send({ success: false, error: 'Business not found' })
    return reply.send({ success: true, data: business })
  })

  // PUT /:id — update
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const body = UpdateBody.parse(req.body)

    const [existing] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Business not found' })

    const updates: Partial<typeof existing> = { updatedAt: Date.now() }
    if (body.name !== undefined) updates.name = body.name
    if (body.domain !== undefined) updates.domain = body.domain
    if (body.industry !== undefined) updates.industry = body.industry
    if (body.stage !== undefined) updates.stage = body.stage
    if (body.health !== undefined) updates.health = body.health
    if (body.metadata !== undefined) updates.metadata = body.metadata as Record<string, unknown>
    if (body.metrics !== undefined) {
      updates.metrics = Object.assign(
        {},
        existing.metrics as Record<string, unknown>,
        body.metrics,
      ) as Record<string, unknown>
    }

    await db.update(businesses).set(updates).where(eq(businesses.id, id))

    const [updated] = await db.select().from(businesses).where(eq(businesses.id, id)).limit(1)
    await emit('business.updated', workspaceId, { businessId: id, changes: Object.keys(updates) })

    return reply.send({ success: true, data: updated })
  })

  // POST /:id/metrics — merge metrics
  app.post('/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const { metrics } = MetricsBody.parse(req.body)

    const [existing] = await db.select().from(businesses)
      .where(and(eq(businesses.id, id), eq(businesses.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Business not found' })

    const merged = Object.assign(
      {},
      existing.metrics as Record<string, unknown>,
      metrics,
    ) as Record<string, unknown>

    await db.update(businesses)
      .set({ metrics: merged, updatedAt: Date.now() })
      .where(eq(businesses.id, id))

    await emit('business.metrics_updated', workspaceId, { businessId: id, keys: Object.keys(metrics) })

    return reply.send({ success: true, data: { businessId: id, metrics: merged } })
  })
}
