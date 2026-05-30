/**
 * Sandbox Routes — /api/v1/sandbox
 *
 * GET  /sessions                   — active + recent sandbox sessions (workspace-scoped)
 * GET  /sessions/:id               — single session detail
 * GET  /sessions/:id/events        — event log for a session
 * POST /sessions/:id/cancel        — cancel a running session (sets status = cancelled)
 * GET  /stats                      — summary counts (active, failed, redacted secrets)
 */
import type { FastifyPluginAsync } from 'fastify'
import { db }              from '../db/client.js'
import { sandboxSessions, sandboxEvents } from '../db/schema.js'
import { eq, and, desc } from 'drizzle-orm'

const sandboxRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /sessions
  fastify.get<{
    Querystring: { workspace_id?: string; status?: string; limit?: string }
  }>('/sessions', async (req, reply) => {
    const { workspace_id, status, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const n = limit ? Number(limit) : 50

    let rows
    if (status) {
      rows = await db.select().from(sandboxSessions)
        .where(and(
          eq(sandboxSessions.workspaceId, workspace_id),
          eq(sandboxSessions.status, status),
        ))
        .orderBy(desc(sandboxSessions.startedAt))
        .limit(n)
    } else {
      rows = await db.select().from(sandboxSessions)
        .where(eq(sandboxSessions.workspaceId, workspace_id))
        .orderBy(desc(sandboxSessions.startedAt))
        .limit(n)
    }

    // Compute timeout remaining for running sessions
    const now = Date.now()
    const enriched = rows.map((s) => ({
      ...s,
      timeoutRemainingMs: s.status === 'running'
        ? Math.max(0, s.startedAt + s.timeoutMs - now)
        : null,
      isLeaseExpired: s.status === 'running' && s.leaseExpiresAt < now,
    }))

    return { success: true, data: enriched }
  })

  // GET /sessions/:id — R146.31 workspace-scope filter
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/sessions/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(sandboxSessions)
      .where(and(eq(sandboxSessions.id, req.params.id), eq(sandboxSessions.workspaceId, ws))).limit(1)
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'Session not found' })

    const now = Date.now()
    const s = rows[0]
    return {
      success: true,
      data: {
        ...s,
        timeoutRemainingMs: s.status === 'running'
          ? Math.max(0, s.startedAt + s.timeoutMs - now)
          : null,
        isLeaseExpired: s.status === 'running' && s.leaseExpiresAt < now,
      },
    }
  })

  // GET /sessions/:id/events — R146.31 workspace-scope filter (was sessionId
  // only; auth'd caller could read any workspace's events by session UUID).
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/sessions/:id/events', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const events = await db.select().from(sandboxEvents)
      .where(and(eq(sandboxEvents.sessionId, req.params.id), eq(sandboxEvents.workspaceId, ws)))
      .orderBy(desc(sandboxEvents.createdAt))
      .limit(200)
    return { success: true, data: events }
  })

  // POST /sessions/:id/cancel — R146.31 workspace-scope filter
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/sessions/:id/cancel', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(sandboxSessions)
      .where(and(eq(sandboxSessions.id, req.params.id), eq(sandboxSessions.workspaceId, ws))).limit(1)
    const session = rows[0]
    if (!session) return reply.code(404).send({ success: false, error: 'Session not found' })
    if (session.status !== 'running') {
      return reply.code(409).send({ success: false, error: `Session is not running (status: ${session.status})` })
    }

    const now = Date.now()
    await db.update(sandboxSessions).set({
      status:      'cancelled',
      completedAt: now,
      updatedAt:   now,
    }).where(eq(sandboxSessions.id, session.id))

    await db.insert(sandboxEvents).values({
      id:          crypto.randomUUID(),
      sessionId:   session.id,
      workspaceId: session.workspaceId,
      leaseOwner:  session.leaseOwner,
      eventType:   'cancelled',
      payload:     { cancelledBy: 'api', ts: now },
      createdAt:   now,
    })

    return { success: true, data: { sessionId: session.id, status: 'cancelled' } }
  })

  // GET /stats — summary for the war room
  fastify.get<{
    Querystring: { workspace_id?: string }
  }>('/stats', async (req, reply) => {
    const { workspace_id } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const all = await db.select({
      status:          sandboxSessions.status,
      secretsRedacted: sandboxSessions.secretsRedacted,
    }).from(sandboxSessions)
      .where(eq(sandboxSessions.workspaceId, workspace_id))

    const stats = {
      total:            all.length,
      active:           all.filter((s) => s.status === 'running').length,
      complete:         all.filter((s) => s.status === 'complete').length,
      failed:           all.filter((s) => s.status === 'failed').length,
      timeout:          all.filter((s) => s.status === 'timeout').length,
      isolationViolations: all.filter((s) => s.status === 'isolation_violation').length,
      totalSecretsRedacted: all.reduce((n, s) => n + (s.secretsRedacted ?? 0), 0),
    }

    return { success: true, data: stats }
  })
}

export default sandboxRoutes
