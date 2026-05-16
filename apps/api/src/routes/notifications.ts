/**
 * Notifications routes
 * POST /api/v1/notifications          — create
 * GET  /api/v1/notifications          — list (filter by read/dismissed)
 * POST /api/v1/notifications/:id/read     — mark read
 * POST /api/v1/notifications/:id/dismiss  — mark dismissed
 * POST /api/v1/notifications/read-all    — mark all read for workspace
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { v7 as uuidv7 }            from 'uuid'
import { desc, eq, and }           from 'drizzle-orm'
import { db }                      from '../db/client.js'
import { notifications }           from '../db/schema.js'

const createSchema = z.object({
  title:      z.string().min(1).max(255),
  body:       z.string().min(1).max(2000),
  type:       z.enum(['info', 'warning', 'error', 'success']).default('info'),
  category:   z.enum(['system', 'workflow', 'approval', 'risk', 'opportunity', 'goal']).default('system'),
  sourceType: z.string().optional(),
  sourceId:   z.string().optional(),
  actionUrl:  z.string().optional(),
  expiresAt:  z.number().int().optional(),
})

export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  const ws = (req: unknown) => ((req as { workspaceId?: string }).workspaceId ?? 'default')

  app.post('/', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message })
    const d = parsed.data
    const workspaceId = ws(req)
    const now = Date.now()
    const id = uuidv7()
    await db.insert(notifications).values({
      id, workspaceId,
      title: d.title, body: d.body, type: d.type, category: d.category,
      ...(d.sourceType !== undefined ? { sourceType: d.sourceType } : {}),
      ...(d.sourceId   !== undefined ? { sourceId:   d.sourceId   } : {}),
      ...(d.actionUrl  !== undefined ? { actionUrl:  d.actionUrl  } : {}),
      ...(d.expiresAt  !== undefined ? { expiresAt:  d.expiresAt  } : {}),
      createdAt: now,
    })
    const [created] = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1)
    return reply.status(201).send({ success: true, data: created })
  })

  app.get('/', async (req, reply) => {
    const { read, dismissed, limit = '30' } = req.query as { read?: string; dismissed?: string; limit?: string }
    const workspaceId = ws(req)
    const rows = await db.select().from(notifications)
      .where(and(
        eq(notifications.workspaceId, workspaceId),
        ...(dismissed === 'true' ? [] : [eq(notifications.dismissed, false)]),
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(Number(limit), 100))

    const filtered = read !== undefined ? rows.filter((n) => n.read === (read === 'true')) : rows
    const unreadCount = rows.filter((n) => !n.read && !n.dismissed).length
    return reply.send({ success: true, data: filtered, meta: { count: filtered.length, unreadCount } })
  })

  app.post('/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.update(notifications).set({ read: true }).where(and(eq(notifications.id, id), eq(notifications.workspaceId, ws(req))))
    return reply.send({ success: true })
  })

  app.post('/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string }
    await db.update(notifications).set({ dismissed: true, read: true }).where(and(eq(notifications.id, id), eq(notifications.workspaceId, ws(req))))
    return reply.send({ success: true })
  })

  app.post('/read-all', async (req, reply) => {
    await db.update(notifications).set({ read: true }).where(and(eq(notifications.workspaceId, ws(req)), eq(notifications.read, false)))
    return reply.send({ success: true })
  })
}
