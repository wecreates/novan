/**
 * Improvement Routes — /api/v1/improvement
 *
 * POST /scan                 — run improvement scan
 * GET  /recommendations      — list recommendations
 * POST /roadmap/generate     — convert open recommendations into roadmap tasks
 * GET  /roadmap              — list roadmap (grouped by phase)
 * GET  /metrics              — optimization tracking metrics
 * POST /recommendations/:id/apply
 * POST /recommendations/:id/dismiss
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  runImprovementScan, generateRoadmap, listRecommendations, listRoadmap,
  computeMetrics, applyRecommendation, dismissRecommendation,
}                         from '../services/improvement-engine.js'

const improvementRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{ Body: { workspace_id?: string } }>('/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const result = await runImprovementScan(ws)
    return { success: true, data: result }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string } }>(
    '/recommendations', async (req, reply) => {
      const { workspace_id, status } = req.query
      if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
      const data = await listRecommendations(workspace_id, status)
      return { success: true, data }
    },
  )

  fastify.post<{ Body: { workspace_id?: string } }>('/roadmap/generate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await generateRoadmap(ws)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/roadmap', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const all = await listRoadmap(ws)
    return {
      success: true,
      data: {
        immediate: all.filter((t) => t.phase === 'immediate'),
        nearTerm:  all.filter((t) => t.phase === 'near_term'),
        backlog:   all.filter((t) => t.phase === 'backlog'),
      },
    }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/metrics', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await computeMetrics(ws)
    return { success: true, data }
  })

  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; approval_granted?: boolean }
  }>('/recommendations/:id/apply', async (req, reply) => {
    const result = await applyRecommendation(
      req.params.id, req.body.actor ?? 'ops-user', req.body.approval_granted === true,
    )
    if (!result.ok) return reply.code(409).send({ success: false, error: result.reason })
    return { success: true, data: { applied: true } }
  })

  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; reason?: string }
  }>('/recommendations/:id/dismiss', async (req, reply) => {
    const { reason } = req.body
    if (!reason) return reply.code(400).send({ success: false, error: 'reason required' })
    await dismissRecommendation(req.params.id, req.body.actor ?? 'ops-user', reason)
    return { success: true, data: { dismissed: true } }
  })
}

export default improvementRoutes
