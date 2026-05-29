/**
 * Auth routes — simple API token management.
 *
 * POST   /api/v1/auth/tokens       — create API token (returns raw token once)
 * GET    /api/v1/auth/tokens       — list tokens for workspace (no raw tokens)
 * DELETE /api/v1/auth/tokens/:id   — revoke token
 * POST   /api/v1/auth/verify       — verify a token
 * GET    /api/v1/auth/me           — get current workspace from token
 */
import { createHash, randomBytes, timingSafeEqual as bufTimingSafeEqual }  from 'node:crypto'

/** Constant-time string comparison to prevent timing attacks on the
 *  bootstrap secret. Node's built-in requires Buffer args of equal length. */
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) return false
  return bufTimingSafeEqual(aBuf, bBuf)
}
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

/** Resolve the workspace ID from the authenticated request context. The
 *  routes that use this all run behind the `authenticate` preHandler,
 *  which guarantees req.workspaceId is set; the explicit guard below
 *  prevents a silent fallback to the magic 'default' workspace if the
 *  preHandler is ever accidentally removed. */
function ws(req: unknown): string {
  const id = (req as { workspaceId?: string }).workspaceId
  if (!id) throw new Error('ws(): workspaceId missing — route must run behind app.authenticate')
  return id
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

  // R146.24 — POST /bootstrap — operator-only initial token mint.
  // Gated by OPERATOR_BOOTSTRAP_SECRET env var (set in the deploy
  // .env). The bootstrap flow exists because every OTHER token-mint
  // endpoint requires existing auth (chicken-and-egg). The operator
  // sets the secret in .env once, hits /bootstrap with it on first
  // visit, gets back a long-lived API token to paste into the PWA's
  // localStorage. Subsequent logins use the standard /tokens flow.
  //
  // Path is in the planned public-prefix allowlist for R146.23. The
  // secret is single-purpose: an attacker who has it can mint tokens
  // for `default` workspace, so it must be treated as equivalent to
  // root access on the box (same trust level as `.env` itself).
  // Tight rate limit (3/min/IP) caps brute-force on a weak secret.
  app.post('/bootstrap', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const expected = process.env['OPERATOR_BOOTSTRAP_SECRET']
    if (!expected) {
      return reply.status(503).send({ success: false, error: 'bootstrap not configured — set OPERATOR_BOOTSTRAP_SECRET' })
    }
    const body = req.body as { secret?: unknown; workspace_id?: unknown; name?: unknown } | null
    const supplied = typeof body?.secret === 'string' ? body.secret : ''
    if (supplied.length === 0 || !timingSafeEqual(supplied, expected)) {
      return reply.status(401).send({ success: false, error: 'invalid bootstrap secret' })
    }
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : 'default'
    const name        = typeof body?.name === 'string' ? body.name.slice(0, 100) : 'operator-bootstrap'
    const rawToken    = generateToken()
    const tokenHash   = sha256(rawToken)
    const prefix      = rawToken.slice(0, 12)
    const now         = Date.now()
    const id          = crypto.randomUUID()
    await db.insert(apiTokens).values({
      id, workspaceId, name, tokenHash, prefix,
      scopes: ['read', 'write'], createdAt: now,
    })
    return reply.status(201).send({
      success: true,
      data: { token: rawToken, id, prefix, workspaceId },
    })
  })

  // POST /tokens — create a new API token. Requires existing
  // authentication: an attacker reaching this endpoint anonymously
  // could otherwise mint tokens in the default workspace.
  // Per-route rate limit caps brute-force creation attempts independent
  // of the global 200/min ceiling.
  app.post('/tokens', {
    onRequest: [app.authenticate],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
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
  app.get('/tokens', { onRequest: [app.authenticate] }, async (req, reply) => {
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

  // DELETE /tokens/:id — revoke a token. Same auth gate as create —
  // otherwise any unauthenticated caller guessing token IDs could
  // revoke arbitrary tokens (denial of service).
  app.delete('/tokens/:id', { onRequest: [app.authenticate] }, async (req, reply) => {
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

  // POST /verify — verify a raw token. Tight rate limit (20/min/IP) caps
  // brute-force enumeration of the 12-char prefix space; without this,
  // the global 200/min limit lets an attacker check 200 candidates per
  // minute against the hash table.
  app.post('/verify', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
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
