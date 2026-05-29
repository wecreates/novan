/**
 * Agent routes — register, monitor, and control autonomous agents.
 *
 * POST /api/v1/agents            — register agent
 * GET  /api/v1/agents            — list agents
 * GET  /api/v1/agents/:id        — detail
 * PUT  /api/v1/agents/:id        — update
 * POST /api/v1/agents/:id/heartbeat — heartbeat
 * POST /api/v1/agents/:id/status    — set status
 * DELETE /api/v1/agents/:id      — deregister
 */

import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { v7 as uuidv7 } from 'uuid'
import { desc, eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, events } from '../db/schema.js'

const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

async function emit(type: string, workspaceId: string, payload: unknown): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload: payload as Record<string, unknown>,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/agents', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[agents]', e.message); return null })
}

const AgentStatus = z.enum(['idle', 'running', 'paused', 'error', 'offline'])

const RegisterBody = z.object({
  name: z.string().min(1).max(200),
  type: z.string().min(1),
  description: z.string().max(1000).optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  capabilities: z.array(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
})

const ListQuery = z.object({
  status: AgentStatus.optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const StatusBody = z.object({
  status: AgentStatus,
})

export const agentsRoutes: FastifyPluginAsync = async (app) => {
  // POST / — register
  app.post('/', async (req, reply) => {
    const body = RegisterBody.parse(req.body)
    const workspaceId = ws(req)
    const now = Date.now()
    const id = uuidv7()

    await db.insert(agents).values({
      id,
      workspaceId,
      name: body.name,
      type: body.type,
      ...(body.description !== undefined ? { description: body.description } : {}),
      capabilities: body.capabilities ?? [],
      config: (body.config ?? {}) as Record<string, unknown>,
      status: 'idle',
      lastActiveAt: null,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    })

    const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1)
    await emit('agent.registered', workspaceId, { agentId: id, name: body.name, type: body.type })

    return reply.code(201).send({ success: true, data: agent })
  })

  // GET / — list
  app.get('/', async (req, reply) => {
    const query = ListQuery.parse(req.query)
    const workspaceId = ws(req)

    const conditions = [eq(agents.workspaceId, workspaceId)]
    if (query.status !== undefined) conditions.push(eq(agents.status, query.status))
    if (query.type !== undefined) conditions.push(eq(agents.type, query.type))

    const rows = await db.select().from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.lastActiveAt))
      .limit(query.limit)

    return reply.send({ success: true, data: rows })
  })

  // GET /:id — detail
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .limit(1)

    if (!agent) return reply.code(404).send({ success: false, error: 'Agent not found' })
    return reply.send({ success: true, data: agent })
  })

  // PUT /:id — update
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const body = UpdateBody.parse(req.body)

    const [existing] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Agent not found' })

    const updates: Partial<typeof existing> = { updatedAt: Date.now() }
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description
    if (body.capabilities !== undefined) updates.capabilities = body.capabilities
    if (body.config !== undefined) updates.config = body.config as Record<string, unknown>

    await db.update(agents).set(updates).where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))

    const [updated] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId))).limit(1)
    await emit('agent.updated', workspaceId, { agentId: id, changes: Object.keys(updates) })

    return reply.send({ success: true, data: updated })
  })

  // POST /:id/heartbeat
  app.post('/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const now = Date.now()

    const [existing] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Agent not found' })

    const updates: Partial<typeof existing> = {
      heartbeatAt: now,
      lastActiveAt: now,
      updatedAt: now,
    }
    if (existing.status === 'offline') updates.status = 'idle'

    await db.update(agents).set(updates).where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
    await emit('agent.heartbeat', workspaceId, { agentId: id, timestamp: now })

    return reply.send({ success: true, data: { agentId: id, timestamp: now } })
  })

  // POST /:id/status
  app.post('/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)
    const { status } = StatusBody.parse(req.body)

    const [existing] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Agent not found' })

    const previousStatus = existing.status
    await db.update(agents).set({ status, updatedAt: Date.now() })
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
    await emit('agent.status_changed', workspaceId, { agentId: id, previousStatus, status })

    return reply.send({ success: true, data: { agentId: id, status } })
  })

  // DELETE /:id — deregister
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const workspaceId = ws(req)

    const [existing] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .limit(1)

    if (!existing) return reply.code(404).send({ success: false, error: 'Agent not found' })

    await db.update(agents).set({ status: 'offline', updatedAt: Date.now() })
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
    await emit('agent.deregistered', workspaceId, { agentId: id, name: existing.name })

    return reply.send({ success: true, data: { agentId: id } })
  })
}
