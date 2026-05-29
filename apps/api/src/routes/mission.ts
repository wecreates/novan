/**
 * routes/mission.ts — backend for /mission page.
 *
 * Wraps mission-charter service. Service existed; route file didn't.
 */
import type { FastifyPluginAsync } from 'fastify'
import { CHARTER, CHARTER_HASH, adherenceReport } from '../services/mission-charter.js'

const missionRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/mission/charter
  fastify.get('/charter', async () => {
    return { success: true, data: { charter: CHARTER, hash: CHARTER_HASH } }
  })

  // GET /api/v1/mission/adherence?workspace_id=...
  fastify.get<{ Querystring: { workspace_id?: string } }>('/adherence', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const report = await adherenceReport(ws)
    return { success: true, data: report }
  })
}

export default missionRoutes
