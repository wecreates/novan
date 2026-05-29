/**
 * routes/sim.ts — backend for /simulation page.
 *
 * Wraps simulation-engine service. Service existed; route file didn't.
 */
import type { FastifyPluginAsync } from 'fastify'
import { buildScenario, listScenarios, simulationWarRoom, type ScenarioKind } from '../services/simulation-engine.js'

const simRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/sim/war-room?workspace_id=...
  fastify.get<{ Querystring: { workspace_id?: string } }>('/war-room', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await simulationWarRoom(ws)
    return { success: true, data }
  })

  // POST /api/v1/sim/scenarios  { workspace_id, kind }
  fastify.post<{ Body: { workspace_id?: string; kind?: string } }>('/scenarios', async (req, reply) => {
    const { workspace_id, kind } = req.body ?? {}
    if (!workspace_id || !kind) return reply.code(400).send({ success: false, error: 'workspace_id + kind required' })
    const result = await buildScenario(workspace_id, kind as ScenarioKind)
    return { success: true, data: result }
  })

  // GET /api/v1/sim/scenarios?workspace_id=...&kind=...&limit=...
  fastify.get<{ Querystring: { workspace_id?: string; kind?: string; limit?: string } }>('/scenarios', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { kind?: ScenarioKind; limit?: number } = {}
    if (req.query.kind)  opts.kind  = req.query.kind as ScenarioKind
    if (req.query.limit) opts.limit = Number(req.query.limit)
    const data = await listScenarios(ws, opts)
    return { success: true, data }
  })
}

export default simRoutes
