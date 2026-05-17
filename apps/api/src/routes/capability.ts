/**
 * Capability Gap Builder routes — /api/v1/capability
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  detectCapabilities, detectGaps, dimensionSummary, CAPABILITY_REGISTRY,
} from '../services/capability-gap-detector.js'
import { planBuild, planAllGaps, persistPlan } from '../services/self-build-planner.js'

const capabilityRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/registry', async () => ({ success: true, data: CAPABILITY_REGISTRY }))

  fastify.get<{ Querystring: { workspace_id?: string } }>('/status', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await detectCapabilities(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/gaps', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await detectGaps(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/dimensions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await dimensionSummary(ws) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/plan/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const plan = await planBuild(ws, req.params.id)
    if (!plan) return reply.code(404).send({ success: false, error: 'unknown capability' })
    return { success: true, data: plan }
  })

  fastify.post<{ Body: { workspace_id?: string; capability_id?: string } }>('/plan/:id/persist', async (req, reply) => {
    const ws = req.body.workspace_id
    const id = (req.params as { id: string }).id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const plan = await planBuild(ws, id)
    if (!plan) return reply.code(404).send({ success: false, error: 'unknown capability' })
    const r = await persistPlan(ws, plan)
    return { success: true, data: { plan, persisted: r } }
  })

  fastify.post<{ Body: { workspace_id?: string; only_verdicts?: Array<'build' | 'hybrid'> } }>('/plan-all-gaps', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts = req.body.only_verdicts ? { onlyVerdicts: req.body.only_verdicts } : undefined
    return { success: true, data: await planAllGaps(ws, opts) }
  })
}

export default capabilityRoutes
