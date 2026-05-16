/**
 * Auth routes — simple API token management.
 *
 * POST   /api/v1/auth/tokens       — create API token (returns raw token once)
 * GET    /api/v1/auth/tokens       — list tokens for workspace (no raw tokens)
 * DELETE /api/v1/auth/tokens/:id   — revoke token
 * POST   /api/v1/auth/verify       — verify a token
 * GET    /api/v1/auth/me           — get current workspace from token
 */
import { createHash, randomBytes }  from 'node:crypto'
import type { FastifyPluginAsync }  from 'fastify'
import { z }                        from 'zod'
import { eq, and, isNull }          from 'drizzle-orm'
import { db }                       from '../db/client.js'
import { apiTokens }                from '../db/schema.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function generateToken(): string {
  return 'ops_' + randomBytes(32).toString('hex')
}

function ws(req: unknown): string {
  return (req as { workspaceId?: string }).workspaceId ?? 'default'
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createTokenSchema = z.object({
  name:      z.string().min(1).max(100),
  scopes:    z.array(z.string()).optional(),
  expiresAt: z.number().int().optional(),
})

const verifySchema = z.object({
  token: z.string().min(1),
})

// ─── Routes ───────────────────────────────────────────────────────────────────

export const authRoutes: FastifyPluginAsync = async (app) => {

  // POST /tokens — create a new API token
  app.post('/tokens', async (req, reply) => {
    const parsed = createTokenSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message })

    const { name, scopes, expiresAt } = parsed.data
    const workspaceId = ws(req)
    const rawToken    = generateToken()
    const tokenHash   = sha256(rawToken)
    const prefix      = rawToken.slice(0, 12)
    const now         = Date.now()
    const id          = crypto.randomUUID()

    await db.insert(apiTokens).values({
      id,
      workspaceId,
      name,
      tokenHash,
      prefix,
      scopes:    scopes ?? ['read', 'write'],
      createdAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    })

    return reply.status(201).send({
      success: true,
      data: { token: rawToken, id, prefix },
    })
  })

  // GET /tokens — list tokens (no raw token hashes)
  app.get('/tokens', async (req, reply) => {
    const workspaceId = ws(req)
    const rows = await db
      .select({
        id:         apiTokens.id,
        name:       apiTokens.name,
        prefix:     apiTokens.prefix,
        scopes:     apiTokens.scopes,
        lastUsedAt: apiTokens.lastUsedAt,
        expiresAt:  apiTokens.expiresAt,
        revokedAt:  apiTokens.revokedAt,
        createdAt:  apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(
        eq(apiTokens.workspaceId, workspaceId),
        isNull(apiTokens.revokedAt),
      ))
      .orderBy(apiTokens.createdAt)

    return reply.send({ success: true, data: rows })
  })

  // DELETE /tokens/:id — revoke a token
  app.delete('/tokens/:id', async (req, reply) => {
    const { id }      = req.params as { id: string }
    const workspaceId = ws(req)
    const now         = Date.now()

    const result = await db
      .update(apiTokens)
      .set({ revokedAt: now })
      .where(and(
        eq(apiTokens.id, id),
        eq(apiTokens.workspaceId, workspaceId),
        isNull(apiTokens.revokedAt),
      ))
      .returning({ id: apiTokens.id })

    if (result.length === 0) {
      return reply.status(404).send({ success: false, error: 'Token not found or already revoked' })
    }

    return reply.send({ success: true })
  })

  // POST /verify — verify a raw token
  app.post('/verify', async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ success: false, error: parsed.error.issues[0]?.message })

    const { token } = parsed.data
    const hash      = sha256(token)
    const now       = Date.now()

    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1)

    if (!row) return reply.send({ success: true, data: { valid: false } })

    if (row.revokedAt !== null && row.revokedAt !== undefined) {
      return reply.send({ success: true, data: { valid: false } })
    }

    if (row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt < now) {
      return reply.send({ success: true, data: { valid: false } })
    }

    // Update lastUsedAt (fire-and-forget, don't await)
    void db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))

    return reply.send({
      success: true,
      data: { valid: true, workspaceId: row.workspaceId, scopes: row.scopes },
    })
  })

  // GET /me — resolve current workspace from Authorization header
  app.get('/me', async (req, reply) => {
    const authHeader = req.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ success: false, error: 'Missing Bearer token' })
    }

    const token = authHeader.slice(7)
    const hash  = sha256(token)
    const now   = Date.now()

    const [row] = await db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1)

    if (!row || row.revokedAt !== null && row.revokedAt !== undefined) {
      return reply.status(401).send({ success: false, error: 'Invalid or revoked token' })
    }

    if (row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt < now) {
      return reply.status(401).send({ success: false, error: 'Token expired' })
    }

    void db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))

    return reply.send({ success: true, data: { workspaceId: row.workspaceId } })
  })
}
