/**
 * Autonomous Economic Intelligence routes — /api/v1/economy
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  economicState, roiAnalysis, allocationSuggestions, efficiencyForecast,
  generateEconomicRecommendations, warRoomSnapshot, evaluateEconomicOutcomes,
  recentEconomicChains,
} from '../services/economic-intelligence.js'

const economyRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/state', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const w = req.query.window_days ? Number(req.query.window_days) : 7
    return { success: true, data: await economicState(ws, w) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/roi', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const w = req.query.window_days ? Number(req.query.window_days) : 30
    return { success: true, data: await roiAnalysis(ws, w) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/allocation', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const w = req.query.window_days ? Number(req.query.window_days) : 7
    return { success: true, data: await allocationSuggestions(ws, w) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/forecast', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const w = req.query.window_days ? Number(req.query.window_days) : 14
    return { success: true, data: await efficiencyForecast(ws, w) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/recommend', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await generateEconomicRecommendations(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/war-room', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await warRoomSnapshot(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/evaluate-outcomes', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await evaluateEconomicOutcomes(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/chains', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentEconomicChains(ws, req.query.limit ? Number(req.query.limit) : 20) }
  })
}

export default economyRoutes
