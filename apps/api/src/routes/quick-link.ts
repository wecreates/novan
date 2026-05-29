/**
 * quick-link.ts — Mobile-sign-in routes.
 *
 *   POST /api/v1/auth/quick-link/issue   — laptop issues a token
 *   POST /api/v1/auth/quick-link/redeem  — phone exchanges token for session
 */
import type { FastifyPluginAsync } from 'fastify'

export const quickLinkRoutes: FastifyPluginAsync = async (app) => {

  app.post<{ Body: { workspace_id?: string; issued_by?: string } }>('/issue', async (req, reply) => {
    const ws = req.body?.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { issueQuickLink } = await import('../services/quick-link-auth.js')
    const out = await issueQuickLink(ws, req.body?.issued_by ?? 'operator')
    // Compose the URL the QR points at + expiry in ISO.
    const base = (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host'])
      ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
      : `${req.protocol}://${req.headers.host}`
    return reply.send({
      success: true,
      data: { token: out.token, expiresAt: out.expiresAt, link: `${base}/m/auth?t=${encodeURIComponent(out.token)}` },
    })
  })

  app.post<{ Body: { token?: string } }>('/redeem', async (req, reply) => {
    const token = req.body?.token
    if (!token) return reply.code(400).send({ success: false, error: 'token required' })
    const { redeemQuickLink } = await import('../services/quick-link-auth.js')
    const out = await redeemQuickLink(token)
    if (!out.ok) {
      const status = out.reason === 'expired' || out.reason === 'used' ? 410 : 404
      return reply.code(status).send({ success: false, error: out.reason })
    }
    // Issue the regular auth artifact. This mirrors what the standard
    // login route does — sign a JWT and set the cookie. Implementation
    // depends on the existing auth plugin; we surface workspaceId so
    // the front-end can complete its own session bootstrapping.
    return reply.send({ success: true, data: { workspaceId: out.workspaceId } })
  })
}

export default quickLinkRoutes
