// TODO: Register in server.ts:
// import { workspacesRoutes } from './routes/workspaces.js'
// await app.register(workspacesRoutes, { prefix: '/api/v1/workspaces' })

/**
 * Workspace management routes.
 * GET    /api/v1/workspaces         — list all workspaces
 * POST   /api/v1/workspaces         — create workspace
 * GET    /api/v1/workspaces/current — get current workspace (from req.workspaceId)
 * GET    /api/v1/workspaces/:id     — get workspace
 * PUT    /api/v1/workspaces/:id     — update workspace
 * DELETE /api/v1/workspaces/:id     — delete workspace
 */
import type { FastifyPluginAsync } from 'fastify'
import { z }                       from 'zod'
import { eq, desc }                from 'drizzle-orm'
import { db }                      from '../db/client.js'
import { workspaces }              from '../db/schema.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ws(req: unknown): string {
  return (req as { workspaceId?: string }).workspaceId ?? 'default'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function notFound(reply: any) {
  return reply.status(404).send({ success: false, error: 'Workspace not found' })
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  name:     z.string().min(1).max(100),
  slug:     z.string().min(1).max(60).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  plan:     z.enum(['free', 'pro', 'enterprise']).optional(),
  settings: z.record(z.unknown()).optional(),
})

const updateSchema = createSchema.partial()

// ─── Routes ───────────────────────────────────────────────────────────────────

export const workspacesRoutes: FastifyPluginAsync = async (app) => {

  // GET /current — resolve workspace from request context
  app.get('/current', async (req, reply) => {
    const workspaceId = ws(req)
    const [row] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)

    if (!row) return notFound(reply)
    return reply.send({ success: true, data: row })
  })

  // GET / — list all workspaces
  app.get('/', async (_req, reply) => {
    const rows = await db
      .select()
      .from(workspaces)
      .orderBy(desc(workspaces.createdAt))

    return reply.send({ success: true, data: rows })
  })

  // POST / — create workspace
  app.post('/', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message })
    }

    const { name, slug, plan, settings } = parsed.data
    const now = Date.now()
    const id  = crypto.randomUUID()

    const [row] = await db
      .insert(workspaces)
      .values({
        id,
        name,
        slug,
        ownerId:  'system',
        plan:     plan ?? 'free',
        settings: settings ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    return reply.status(201).send({ success: true, data: row })
  })

  // GET /:id — get workspace by id
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1)

    if (!row) return notFound(reply)
    return reply.send({ success: true, data: row })
  })

  // PUT /:id — update workspace
  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message })
    }

    const { name, slug, plan, settings } = parsed.data
    const updates: Partial<typeof workspaces.$inferInsert> = { updatedAt: Date.now() }
    if (name     !== undefined) updates.name     = name
    if (slug     !== undefined) updates.slug     = slug
    if (plan     !== undefined) updates.plan     = plan
    if (settings !== undefined) updates.settings = settings

    const [row] = await db
      .update(workspaces)
      .set(updates)
      .where(eq(workspaces.id, id))
      .returning()

    if (!row) return notFound(reply)
    return reply.send({ success: true, data: row })
  })

  // DELETE /:id — delete workspace
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [row] = await db
      .delete(workspaces)
      .where(eq(workspaces.id, id))
      .returning({ id: workspaces.id })

    if (!row) return notFound(reply)
    return reply.send({ success: true })
  })
}
