/**
 * push.ts — Web Push routes.
 *
 *   GET    /api/v1/push/public-key          — VAPID public key for browser subscribe
 *   POST   /api/v1/push/subscribe           — register a subscription
 *   POST   /api/v1/push/unsubscribe         — revoke a subscription
 *   POST   /api/v1/push/test                — fire a test notification to all subs
 *   GET    /api/v1/push/latest              — most recent broadcast payload (SW uses this)
 */
import type { FastifyPluginAsync } from 'fastify'

export const pushRoutes: FastifyPluginAsync = async (app) => {

  app.get('/public-key', async (_req, reply) => {
    const { publicVapidKey } = await import('../services/web-push.js')
    const key = publicVapidKey()
    if (!key) return reply.code(503).send({ success: false, error: 'VAPID keys not configured' })
    return reply.send({ success: true, data: { publicKey: key } })
  })

  app.post<{ Body: { workspace_id?: string; subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; user_agent?: string } }>('/subscribe', async (req, reply) => {
    const b = req.body ?? {}
    const ws = b.workspace_id
    const s = b.subscription
    if (!ws || !s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) {
      return reply.code(400).send({ success: false, error: 'workspace_id + subscription{endpoint,keys{p256dh,auth}} required' })
    }
    // R146.39 — reject internal-host endpoints at registration so we never
    // even persist an SSRF target. sendPushOne also has a defense-in-depth
    // check, but stopping at the door is cleaner.
    let parsedEp: URL
    try { parsedEp = new URL(s.endpoint) } catch {
      return reply.code(400).send({ success: false, error: 'invalid subscription.endpoint URL' })
    }
    if (parsedEp.protocol !== 'https:') {
      return reply.code(400).send({ success: false, error: 'subscription.endpoint must be https' })
    }
    const { isInternalHost } = await import('../services/image-storage.js')
    if (isInternalHost(parsedEp.hostname)) {
      return reply.code(400).send({ success: false, error: `internal host blocked: ${parsedEp.hostname}` })
    }
    const { recordSubscription } = await import('../services/web-push.js')
    await recordSubscription(ws, { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, b.user_agent)
    return reply.send({ success: true })
  })

  app.post<{ Body: { workspace_id?: string; endpoint?: string } }>('/unsubscribe', async (req, reply) => {
    const ws = req.body?.workspace_id
    const endpoint = req.body?.endpoint
    if (!ws || !endpoint) return reply.code(400).send({ success: false, error: 'workspace_id + endpoint required' })
    const { revokeSubscription } = await import('../services/web-push.js')
    await revokeSubscription(ws, endpoint, 'operator')
    return reply.send({ success: true })
  })

  app.post<{ Body: { workspace_id?: string; title?: string; body?: string; url?: string } }>('/test', async (req, reply) => {
    const ws = req.body?.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { broadcastPush } = await import('../services/web-push.js')
    const out = await broadcastPush(ws, {
      title: req.body?.title ?? 'Novan',
      body:  req.body?.body  ?? 'Test notification from Novan.',
      ...(req.body?.url ? { url: req.body.url } : {}),
      tag: 'test',
    })
    return reply.send({ success: true, data: out })
  })

  app.get<{ Querystring: { workspace_id?: string } }>('/latest', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    try {
      const { db } = await import('../db/client.js')
      const { events } = await import('../db/schema.js')
      const { and, eq, desc } = await import('drizzle-orm')
      const rows = await db.select({ payload: events.payload, createdAt: events.createdAt })
        .from(events)
        .where(and(eq(events.workspaceId, ws), eq(events.type, 'push.broadcast')))
        .orderBy(desc(events.createdAt))
        .limit(1)
        .catch(() => [])
      if (rows.length === 0) return reply.send({ success: true, data: null })
      return reply.send({ success: true, data: { ...(rows[0]!.payload as object), at: Number(rows[0]!.createdAt) } })
    } catch (e) {
      return reply.code(500).send({ success: false, error: (e as Error).message })
    }
  })
}

export default pushRoutes
