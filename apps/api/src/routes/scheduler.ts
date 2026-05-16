/**
 * Scheduler routes — cron-based workflow triggers.
 *
 * POST   /api/v1/scheduler          — create trigger
 * GET    /api/v1/scheduler          — list triggers
 * GET    /api/v1/scheduler/:id      — get trigger
 * PUT    /api/v1/scheduler/:id      — update trigger
 * DELETE /api/v1/scheduler/:id      — delete trigger
 * POST   /api/v1/scheduler/:id/enable  — enable
 * POST   /api/v1/scheduler/:id/disable — disable
 * POST   /api/v1/scheduler/:id/trigger — manual trigger now
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eq, and, asc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'
import { scheduledTriggers, workflowRuns, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

function estimateNextRun(_cronExpr: string): number {
  // Simple estimate: next run in 1 hour; a real impl would use a cron parser
  return Date.now() + 3_600_000
}

const CreateSchema = z.object({
  name:           z.string().min(1),
  workflowId:     z.string().min(1),
  cronExpression: z.string().min(1),
  timezone:       z.string().default('UTC'),
  enabled:        z.boolean().default(true),
  description:    z.string().optional(),
  payload:        z.record(z.unknown()).optional(),
})

const UpdateSchema = z.object({
  name:           z.string().min(1).optional(),
  description:    z.string().optional(),
  cronExpression: z.string().min(1).optional(),
  timezone:       z.string().optional(),
  enabled:        z.boolean().optional(),
  payload:        z.record(z.unknown()).optional(),
})

export const schedulerRoutes: FastifyPluginAsync = async (app) => {

  // POST / — create trigger
  app.post('/', async (req, reply) => {
    const body = CreateSchema.parse(req.body)
    const workspaceId = ws(req)
    const now = Date.now()
    const id = uuidv7()

    await db.insert(scheduledTriggers).values({
      id,
      workspaceId,
      name:           body.name,
      workflowId:     body.workflowId,
      cronExpression: body.cronExpression,
      timezone:       body.timezone,
      enabled:        body.enabled,
      nextRunAt:      estimateNextRun(body.cronExpression),
      runCount:       0,
      failureCount:   0,
      createdAt:      now,
      updatedAt:      now,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.payload     !== undefined ? { payload: body.payload }         : {}),
    })

    const [row] = await db.select().from(scheduledTriggers).where(eq(scheduledTriggers.id, id))
    return reply.status(201).send({ success: true, data: row })
  })

  // GET / — list triggers
  app.get('/', async (req, reply) => {
    const query = z.object({
      enabled: z.enum(['true', 'false']).optional(),
    }).parse(req.query)

    const workspaceId = ws(req)
    const conditions = [eq(scheduledTriggers.workspaceId, workspaceId)]
    if (query.enabled !== undefined) {
      conditions.push(eq(scheduledTriggers.enabled, query.enabled === 'true'))
    }

    const rows = await db.select().from(scheduledTriggers)
      .where(and(...conditions))
      .orderBy(asc(scheduledTriggers.name))

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  // GET /:id — get trigger
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, ws(req))))
    if (!row) return reply.status(404).send({ success: false, error: 'Not found' })
    return reply.send({ success: true, data: row })
  })

  // PUT /:id — update trigger
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const body = UpdateSchema.parse(req.body)

    const [existing] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })

    const cronChanged = body.cronExpression !== undefined && body.cronExpression !== existing.cronExpression

    await db.update(scheduledTriggers).set({
      ...(body.name           !== undefined ? { name:           body.name }           : {}),
      ...(body.description    !== undefined ? { description:    body.description }    : {}),
      ...(body.cronExpression !== undefined ? { cronExpression: body.cronExpression } : {}),
      ...(body.timezone       !== undefined ? { timezone:       body.timezone }       : {}),
      ...(body.enabled        !== undefined ? { enabled:        body.enabled }        : {}),
      ...(body.payload        !== undefined ? { payload:        body.payload }        : {}),
      ...(cronChanged ? { nextRunAt: estimateNextRun(body.cronExpression!) } : {}),
      updatedAt: Date.now(),
    }).where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))

    const [row] = await db.select().from(scheduledTriggers).where(eq(scheduledTriggers.id, id))
    return reply.send({ success: true, data: row })
  })

  // DELETE /:id — delete trigger
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })
    await db.delete(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    return reply.send({ success: true })
  })

  // POST /:id/enable
  app.post('/:id/enable', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })
    await db.update(scheduledTriggers).set({
      enabled:   true,
      nextRunAt: estimateNextRun(existing.cronExpression),
      updatedAt: Date.now(),
    }).where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    const [row] = await db.select().from(scheduledTriggers).where(eq(scheduledTriggers.id, id))
    return reply.send({ success: true, data: row })
  })

  // POST /:id/disable
  app.post('/:id/disable', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [existing] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    if (!existing) return reply.status(404).send({ success: false, error: 'Not found' })
    await db.update(scheduledTriggers).set({
      enabled:   false,
      updatedAt: Date.now(),
    }).where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    const [row] = await db.select().from(scheduledTriggers).where(eq(scheduledTriggers.id, id))
    return reply.send({ success: true, data: row })
  })

  // POST /:id/trigger — manual trigger
  app.post('/:id/trigger', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const [trigger] = await db.select().from(scheduledTriggers)
      .where(and(eq(scheduledTriggers.id, id), eq(scheduledTriggers.workspaceId, workspaceId)))
    if (!trigger) return reply.status(404).send({ success: false, error: 'Not found' })

    const runId = uuidv7()
    const now = Date.now()

    await db.insert(workflowRuns).values({
      id:          runId,
      workspaceId,
      workflowId:  trigger.workflowId,
      triggeredBy: 'scheduler:manual',
      triggeredAt: now,
      traceId:     uuidv7(),
      context:     (trigger.payload ?? {}) as Record<string, unknown>,
    })

    await db.insert(events).values({
      id:            uuidv7(),
      type:          'scheduler.trigger.manual',
      workspaceId,
      payload:       { triggerId: trigger.id, runId, workflowId: trigger.workflowId } as Record<string, unknown>,
      traceId:       uuidv7(),
      correlationId: uuidv7(),
      causationId:   null,
      source:        'api/scheduler',
      version:       1,
      createdAt:     now,
    }).catch(() => null)

    return reply.send({ success: true, data: { runId } })
  })
}
