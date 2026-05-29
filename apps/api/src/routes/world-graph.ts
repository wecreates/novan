/**
 * World graph routes — /api/v1/world-graph/*
 * + strategic priority — /api/v1/priority
 */
import type { FastifyPluginAsync } from 'fastify'
import { populateWorldGraph, neighbors, subgraph } from '../services/world-graph.js'
import { rankStrategicPriority } from '../services/strategic-priority.js'

const worldGraphRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{ Body: { workspace_id?: string } }>('/populate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await populateWorldGraph(ws) }
  })

  fastify.get<{
    Querystring: { workspace_id?: string; kind?: string; id?: string }
  }>('/neighbors', async (req, reply) => {
    const { workspace_id, kind, id } = req.query
    if (!workspace_id || !kind || !id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, kind, id required' })
    }
    return { success: true, data: await neighbors(workspace_id, kind, id) }
  })

  fastify.get<{
    Querystring: { workspace_id?: string; kind?: string; id?: string; max_hops?: string; max_per_node?: string }
  }>('/subgraph', async (req, reply) => {
    const { workspace_id, kind, id } = req.query
    if (!workspace_id || !kind || !id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, kind, id required' })
    }
    return { success: true, data: await subgraph(workspace_id, kind, id, {
      ...(req.query.max_hops     ? { maxHops:    Number(req.query.max_hops) } : {}),
      ...(req.query.max_per_node ? { maxPerNode: Number(req.query.max_per_node) } : {}),
    }) }
  })
}

const priorityRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { workspace_id?: string } }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await rankStrategicPriority(ws) }
  })
}

export { worldGraphRoutes, priorityRoutes }
export default worldGraphRoutes
