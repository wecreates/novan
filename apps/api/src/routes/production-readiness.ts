/**
 * Production Readiness Routes — /api/v1/production-readiness
 *
 * POST /audit                — run a new audit
 * GET  /audit/latest         — latest audit
 * GET  /audits               — list audits
 * GET  /lock                 — current launch lock status
 * POST /lock/override        — admin override (requires reason)
 * POST /lock/override/revoke — revoke override
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  runAudit, getLatestAudit, listAudits, getLaunchLock,
  applyOverride, revokeOverride,
}                         from '../services/production-readiness.js'

const productionReadinessRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.post<{
    Body: { workspace_id?: string; triggered_by?: string }
  }>('/audit', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const result = await runAudit(ws, req.body.triggered_by ?? 'api')
    return { success: true, data: result }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/audit/latest', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const audit = await getLatestAudit(ws)
    return { success: true, data: audit }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/audits', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listAudits(ws, req.query.limit ? Number(req.query.limit) : 20)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/lock', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const lock = await getLaunchLock(ws)
    return { success: true, data: lock }
  })

  fastify.post<{
    Body: { workspace_id?: string; admin_id?: string; reason?: string; ttl_ms?: number }
  }>('/lock/override', async (req, reply) => {
    const { workspace_id, admin_id, reason, ttl_ms } = req.body
    if (!workspace_id || !admin_id || !reason) {
      return reply.code(400).send({ success: false, error: 'workspace_id, admin_id, reason required' })
    }
    const result = await applyOverride(workspace_id, admin_id, reason, ttl_ms ?? 3600_000)
    if (!result.ok) return reply.code(400).send({ success: false, error: result.reason })
    return { success: true, data: { applied: true } }
  })

  fastify.post<{
    Body: { workspace_id?: string; admin_id?: string }
  }>('/lock/override/revoke', async (req, reply) => {
    const { workspace_id, admin_id } = req.body
    if (!workspace_id || !admin_id) {
      return reply.code(400).send({ success: false, error: 'workspace_id, admin_id required' })
    }
    await revokeOverride(workspace_id, admin_id)
    return { success: true, data: { revoked: true } }
  })
}

export default productionReadinessRoutes
