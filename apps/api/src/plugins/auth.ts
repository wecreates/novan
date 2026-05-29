/**
 * Auth plugin — JWT verification + API token (ops_xxx) support.
 *
 * Decorates request with:
 *   req.userId      — authenticated user ID (or 'api-token' for API token auth)
 *   req.workspaceId — active workspace ID
 *
 * JWT shape: { sub: userId, wid: workspaceId, exp: ..., iat: ... }
 * API token shape: Bearer ops_<64-hex>  — looked up by SHA-256 hash in api_tokens table
 */
import { createHash }                                            from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import fp                                                        from 'fastify-plugin'
import { eq, and, isNull }                                       from 'drizzle-orm'
import { db }                                                    from '../db/client.js'
import { apiTokens }                                             from '../db/schema.js'

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  interface FastifyRequest {
    userId:      string
    workspaceId: string
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Local-dev auto-auth: when NODE_ENV !== 'production', requests with
 *  no Bearer token transparently get a default operator identity so
 *  the solo-operator UI works without a login flow. Production keeps
 *  the strict Bearer requirement. Read per-request so tests can mock. */
function devAutoAuthActive(): boolean {
  return process.env['NODE_ENV'] !== 'production'
}

const authPluginImpl: FastifyPluginAsync = async (app) => {
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) {
      if (devAutoAuthActive()) {
        // Solo-operator local-dev shortcut. Workspace pulled from query
        // string when present, else default — matches the rest of the
        // codebase's default-workspace convention.
        const qs = (req.query as Record<string, unknown>) ?? {}
        const ws = String(qs['workspace_id'] ?? qs['workspaceId'] ?? '') || 'default'
        req.userId      = 'operator'
        req.workspaceId = ws
        return
      }
      return reply.status(401).send({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: req.id })
    }

    const rawToken = authHeader.slice(7)

    // ── API token path (ops_xxx) ────────────────────────────────────────────────
    if (rawToken.startsWith('ops_')) {
      const hash = sha256(rawToken)
      const now  = Date.now()
      const [row] = await db
        .select({
          id:          apiTokens.id,
          workspaceId: apiTokens.workspaceId,
          revokedAt:   apiTokens.revokedAt,
          expiresAt:   apiTokens.expiresAt,
          scopes:      apiTokens.scopes,
        })
        .from(apiTokens)
        .where(and(eq(apiTokens.tokenHash, hash), isNull(apiTokens.revokedAt)))
        .limit(1)

      if (!row) {
        return reply.status(401).send({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: req.id })
      }
      if (row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt < now) {
        return reply.status(401).send({ success: false, error: 'Token expired', code: 'UNAUTHORIZED', requestId: req.id })
      }

      req.userId      = 'api-token'
      req.workspaceId = row.workspaceId

      // fire-and-forget lastUsedAt
      void db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id))
      return
    }

    // ── JWT path ────────────────────────────────────────────────────────────────
    try {
      const payload   = await req.jwtVerify<{ sub: string; wid: string }>()
      req.userId      = payload.sub
      req.workspaceId = payload.wid
    } catch {
      return reply.status(401).send({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED', requestId: req.id })
    }
  })
}

export const authPlugin = fp(authPluginImpl, { name: 'auth' })
