/**
 * Recap routes — /api/v1/recap/*
 * Read-only executive summary of "while you were away" activity.
 */
import type { FastifyPluginAsync } from 'fastify'
import { generateRecap, acknowledgeRecap } from '../services/recap.js'

import { wsOf as _wsOf } from '../util/ws-of.js'
// Recap routes need undefined-on-no-fallback (handlers return 400 if absent),
// not the default-string behaviour of the shared helper.
function wsOf(req: unknown, fallback?: string): string | undefined {
  const auth = (req as { workspaceId?: string }).workspaceId
  if (auth) return auth
  return fallback
}
void _wsOf  // keep import for future migration

const recapRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string; operator_id?: string } }>('/', async (req, reply) => {
    const ws = wsOf(req, req.query.workspace_id)
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await generateRecap(ws, req.query.operator_id ?? 'default') }
  })

  fastify.post<{ Body: { workspace_id?: string; operator_id?: string } }>('/acknowledge', async (req, reply) => {
    const ws = wsOf(req, req.body.workspace_id)
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await acknowledgeRecap(ws, req.body.operator_id ?? 'default')
    return { success: true, data: { acknowledgedAt: Date.now() } }
  })
}

export default recapRoutes
