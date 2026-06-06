/**
 * R146.329 (#5) — generic JWT-gated brain op dispatcher.
 *
 * 1000+ ops exist in OPERATIONS but only ~12 have public routes. This
 * single endpoint lets the operator UI invoke any op while still:
 *   - requiring auth (no loopback bypass)
 *   - whitelisting by risk level (low/medium auto-allowed; high needs
 *     explicit operator confirmation token)
 *   - forcing workspaceId from auth claim (no body spoofing)
 *
 * Op shape returned matches /admin/brain for consistency.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { wsOf } from '../util/ws-of.js'

interface OpSpec {
  description?: string
  risk?:        string
  handler:      (ws: string, params: Record<string, unknown>) => Promise<unknown>
}

const brainOpRoutes: FastifyPluginAsync = async (app) => {
  type AuthFn = (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  const authenticate = (app as unknown as { authenticate: AuthFn }).authenticate

  // 30/min per workspace — same as the admin bridge
  app.post<{ Body: { op?: string; params?: Record<string, unknown>; highRiskConfirm?: string } }>(
    '/brain/op',
    {
      onRequest: [authenticate],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const ws = wsOf(req)
      const op = String(req.body?.op ?? '').trim()
      if (!op) return reply.code(400).send({ success: false, error: 'op required' })

      const { OPERATIONS } = await import('../services/brain-task.js')
      const spec = (OPERATIONS as Record<string, OpSpec>)[op]
      if (!spec) return reply.code(404).send({ success: false, error: `unknown op: ${op}` })

      const risk = spec.risk ?? 'low'
      if (risk === 'high' && req.body?.highRiskConfirm !== 'OPERATOR_APPROVED') {
        return reply.code(403).send({
          success: false,
          error: `op "${op}" is risk=high; resend with highRiskConfirm:"OPERATOR_APPROVED"`,
          risk,
        })
      }
      if (risk === 'critical' || risk === 'extreme') {
        return reply.code(403).send({
          success: false,
          error: `op "${op}" is risk=${risk}; not exposed on public route — use /admin/brain (loopback)`,
        })
      }

      try {
        const result = await spec.handler(ws, req.body?.params ?? {})
        return reply.send({ success: true, op, risk, data: result })
      } catch (e) {
        return reply.code(500).send({ success: false, op, error: (e as Error).message.slice(0, 500) })
      }
    },
  )

  // Discovery — listed ops the UI can render.
  app.get<{ Querystring: { search?: string; risk?: string } }>(
    '/brain/ops',
    { onRequest: [authenticate] },
    async (req, reply) => {
      const { OPERATIONS } = await import('../services/brain-task.js')
      const search = (req.query.search ?? '').toLowerCase()
      const riskFilter = req.query.risk
      const ops = Object.entries(OPERATIONS as Record<string, OpSpec>)
        .map(([name, spec]) => ({
          name, description: spec.description ?? '', risk: spec.risk ?? 'low',
        }))
        .filter(o => !search || o.name.toLowerCase().includes(search) || o.description.toLowerCase().includes(search))
        .filter(o => !riskFilter || o.risk === riskFilter)
        .slice(0, 500)
      return reply.send({ success: true, count: ops.length, ops })
    },
  )
}

export default brainOpRoutes
