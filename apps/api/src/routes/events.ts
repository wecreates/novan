/**
 * Event routes — event log query + SSE stream.
 *
 * GET  /api/v1/events       — paginated event log
 * GET  /api/v1/events/stream — SSE real-time event stream
 * POST /api/v1/events       — internal event publish (service-to-service)
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                from 'zod'
import { v7 as uuidv7 }     from 'uuid'
import { db }               from '../db/client.js'
import { events }           from '../db/schema.js'
import { eq, and, desc, lte, gte } from 'drizzle-orm'
import type { WorkspaceId } from '@ops/shared-types'
import { EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

const ListEventsSchema = z.object({
  type:   z.string().optional(),
  since:  z.coerce.number().optional(),
  before: z.coerce.number().optional(),
  limit:  z.coerce.number().min(1).max(500).default(50),
})

export const eventRoutes: FastifyPluginAsync = async (app) => {

  // List events (paginated)
  app.get('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const query       = ListEventsSchema.parse(req.query)

    const conditions = [eq(events.workspaceId, workspaceId)]
    if (query.since)  conditions.push(gte(events.createdAt, query.since))
    if (query.before) conditions.push(lte(events.createdAt, query.before))

    const rows = await db.select()
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.createdAt))
      .limit(query.limit)

    return reply.send({ success: true, data: rows, meta: { count: rows.length } })
  })

  // Internal event publish (authenticated service-to-service)
  app.post('/', { onRequest: [app.authenticate] }, async (req, reply) => {
    const workspaceId = req.workspaceId as WorkspaceId
    const body = req.body as { type: string; payload: unknown; traceId?: string; correlationId?: string }
    const now  = Date.now()
    const id   = uuidv7()

    const [event] = await db.insert(events).values({
      id,
      type:          body.type,
      workspaceId,
      payload:       body.payload as Record<string, unknown>,
      traceId:       body.traceId ?? id,
      correlationId: body.correlationId ?? id,
      causationId:   null,
      source:        req.headers['x-service-name'] as string ?? 'api',
      version:       EVENT_SCHEMA_VERSION,
      createdAt:     now,
    }).returning()

    return reply.status(201).send({ success: true, data: event })
  })
}
