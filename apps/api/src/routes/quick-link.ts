/**
 * quick-link.ts — Mobile-sign-in routes.
 *
 *   POST /api/v1/auth/quick-link/issue   — laptop issues a token
 *   POST /api/v1/auth/quick-link/redeem  — phone exchanges token for session
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'

export const quickLinkRoutes: FastifyPluginAsync = async (app) => {

  // R146.36 — gate /issue. Previously this was in the public allowlist
  // (only /redeem needs to be public — the phone hasn't authed yet, only
  // possession of the token from a QR scan). Live-confirmed any caller on
  // Tailscale could mint a token for ANY workspace_id, then have x-forwarded-*
  // headers spoofed into the returned link URL to point at a phishing
  // host. /redeem is currently a no-op (returns workspaceId only, no
  // cookie/JWT — feature stub from R130) so impact today is zero, but
  // closing the hole before someone wires up actual session minting.
  app.post<{ Body: { workspace_id?: string; issued_by?: string } }>('/issue', async (req, reply) => {
    type AuthFn = (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    const authenticate = (app as unknown as { authenticate: AuthFn }).authenticate
    await authenticate(req, reply)
    if (reply.sent) return
    const ws = req.body?.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    // R146.32-style scope: the auth'd caller can only mint for their own ws.
    const authWs = (req as unknown as { workspaceId?: string }).workspaceId
    if (authWs && authWs !== ws) {
      return reply.code(403).send({ success: false, error: 'cross-workspace mint denied' })
    }
    const { issueQuickLink } = await import('../services/quick-link-auth.js')
    const out = await issueQuickLink(ws, req.body?.issued_by ?? 'operator')
    // R146.36 — base URL: prefer explicit env config; otherwise req.headers.host
    // (without trusting x-forwarded-* which an attacker on the network can set
    // freely). Operator should configure NOVAN_PUBLIC_URL once Caddy fronting
    // is finalized.
    // req.protocol respects x-forwarded-proto when trust-proxy is on, so
    // we don't rely on it; pick https vs http based on prod/dev convention,
    // and let NOVAN_PUBLIC_URL override entirely.
    const fallbackScheme = process.env['NODE_ENV'] === 'production' ? 'https' : 'http'
    const base = process.env['NOVAN_PUBLIC_URL']
      ?? `${fallbackScheme}://${req.headers.host ?? 'localhost'}`
    return reply.send({
      success: true,
      data: { token: out.token, expiresAt: out.expiresAt, link: `${base}/m/auth?t=${encodeURIComponent(out.token)}` },
    })
  })

  // R146.69 — finish the QR mobile sign-in flow. Pre-this commit, /redeem
  // validated the single-use token but returned only { workspaceId }, no
  // session artifact. The phone had no way to authenticate on subsequent
  // requests. Now: on successful redeem, mint an ops_xxx API token
  // (same shape + lifecycle as the R146.24 bootstrap path) and return
  // it to the phone. The phone stores it in localStorage('ops_auth_token')
  // and uses it as Bearer for every API call from then on.
  //
  // Security stays tight: /issue is auth-gated (R146.36), so the token
  // in the QR can only have been minted by an already-authenticated
  // laptop. /redeem is public but consumes the single-use token; an
  // attacker who intercepts the QR has 5 min before expiry and races
  // the operator's phone. Same threat model as any other QR-sign-in.
  app.post<{ Body: { token?: string; device_name?: string } }>('/redeem', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const token = req.body?.token
    if (!token) return reply.code(400).send({ success: false, error: 'token required' })
    const { redeemQuickLink } = await import('../services/quick-link-auth.js')
    const out = await redeemQuickLink(token)
    if (!out.ok) {
      const status = out.reason === 'expired' || out.reason === 'used' ? 410 : 404
      return reply.code(status).send({ success: false, error: out.reason })
    }

    // Mint a long-lived ops_xxx token bound to the operator's workspace.
    // Mirrors the apiTokens insert from R146.24 bootstrap + R35 token CRUD.
    const { randomBytes, createHash } = await import('node:crypto')
    const { db } = await import('../db/client.js')
    const { apiTokens } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')

    const rawToken  = `ops_${randomBytes(32).toString('hex')}`
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    const prefix    = rawToken.slice(0, 12)
    const now       = Date.now()
    const deviceName = (typeof req.body?.device_name === 'string' && req.body.device_name.trim().length > 0)
      ? req.body.device_name.trim().slice(0, 80)
      : 'mobile-quick-link'

    await db.insert(apiTokens).values({
      id:          uuidv7(),
      workspaceId: out.workspaceId,
      name:        deviceName,
      tokenHash,
      prefix,
      scopes:      ['read', 'write'],
      createdAt:   now,
    })

    return reply.send({
      success: true,
      data: { token: rawToken, workspaceId: out.workspaceId, prefix },
    })
  })
}

export default quickLinkRoutes
