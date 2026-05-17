/**
 * Governance + Explainability routes — /api/v1/governance + /api/v1/explain
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  gate, classifyAutonomousAction, isProtectedPath,
  stabilitySnapshot, autonomousPatchesToday, deploymentsToday,
  GOVERNANCE_DAILY_LIMITS, type AutonomousIntent,
} from '../services/governance-core.js'
import { currentLimits, snapshot as governorSnapshot } from '../services/resource-governor.js'
import { explainRecommendation, explainTop, confidenceSurfaces } from '../services/explainability.js'

const governanceRoutes: FastifyPluginAsync = async (fastify) => {

  /** Autonomous-action gate check (read-only — does NOT execute the action). */
  fastify.post<{
    Body: {
      workspace_id?: string
      intent?:       string
      context?:      Record<string, unknown>
    }
  }>('/check', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.intent) return reply.code(400).send({ success: false, error: 'workspace_id, intent required' })
    const result = await gate({
      workspaceId: b.workspace_id,
      intent:      b.intent as AutonomousIntent,
      ...(b.context !== undefined ? { context: b.context } : {}),
    })
    return { success: true, data: result }
  })

  fastify.get<{ Querystring: { path?: string } }>('/protected-check', async (req, reply) => {
    const fp = req.query.path
    if (!fp) return reply.code(400).send({ success: false, error: 'path required' })
    return { success: true, data: isProtectedPath(fp) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/snapshot', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const [stability, govLimits, govState, patchesToday, deployToday] = await Promise.all([
      stabilitySnapshot(ws),
      Promise.resolve(currentLimits()),
      governorSnapshot(ws),
      autonomousPatchesToday(ws),
      deploymentsToday(ws),
    ])
    return {
      success: true,
      data: {
        capturedAt: Date.now(),
        stability,
        runtimeGovernor: {
          limits: govLimits,
          state:  govState,
          dailyCounters: {
            autonomousPatchesToday: patchesToday,
            deploymentsToday:       deployToday,
            limits:                 GOVERNANCE_DAILY_LIMITS,
          },
        },
      },
    }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/stability', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await stabilitySnapshot(ws) }
  })
}

const explainRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/recommendations/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const exp = await explainRecommendation(ws, req.params.id)
    if (!exp) return reply.code(404).send({ success: false, error: 'recommendation not found' })
    return { success: true, data: exp }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/top', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const limit = req.query.limit ? Number(req.query.limit) : 5
    return { success: true, data: await explainTop(ws, limit) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/confidence', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await confidenceSurfaces(ws) }
  })
}

export { governanceRoutes, explainRoutes }
