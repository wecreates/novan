/**
 * Stream routes — SSE live event feed for a workspace.
 *
 * GET /api/v1/stream — Server-Sent Events stream
 */

import type { FastifyPluginAsync } from 'fastify'
import { desc, eq, and, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { events } from '../db/schema.js'

export const streamRoutes: FastifyPluginAsync = async (app) => {
  // GET / — SSE stream of live events
  app.get('/', async (req, reply) => {
    const workspaceId = ((req as { workspaceId?: string }).workspaceId ?? 'default')

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })

    const send = (eventType: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch { /* client disconnected */ }
    }

    send('connected', { timestamp: Date.now() })

    let lastSeenAt = Date.now() - 5_000

    const poll = setInterval(async () => {
      try {
        const newEvents = await db.select().from(events)
          .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, lastSeenAt)))
          .orderBy(desc(events.createdAt))
          .limit(20)

        for (const evt of [...newEvents].reverse()) {
          send('event', evt)
          if (evt.createdAt >= lastSeenAt) lastSeenAt = evt.createdAt + 1
        }
      } catch { /* db error, continue */ }
    }, 2_000)

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': heartbeat\n\n') } catch { /* ignore */ }
    }, 25_000)

    return new Promise<void>((resolve) => {
      req.raw.on('close', () => {
        clearInterval(poll)
        clearInterval(heartbeat)
        resolve()
      })
    })
  })
}
