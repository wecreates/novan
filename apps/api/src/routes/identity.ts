/**
 * routes/identity.ts — backend for /identity page.
 *
 * Wraps identity-core service. Service existed for some time but the
 * route file didn't — frontend got 404 on every visit.
 */
import type { FastifyPluginAsync } from 'fastify'
import { getProfile, identityDriftReport, recordAudit, type OutputType } from '../services/identity-core.js'

const VALID_OUTPUT_TYPES: OutputType[] = ['incident', 'brief', 'research', 'patch', 'risk', 'rec', 'social', 'support']

const identityRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/v1/identity/profile?workspace_id=...
  fastify.get<{ Querystring: { workspace_id?: string } }>('/profile', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const profile = await getProfile(ws)
    return { success: true, data: profile }
  })

  // GET /api/v1/identity/drift?workspace_id=...&hours=24
  fastify.get<{ Querystring: { workspace_id?: string; hours?: string } }>('/drift', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const hours = req.query.hours ? Number(req.query.hours) : 24
    const report = await identityDriftReport(ws, hours)
    return { success: true, data: report }
  })

  // POST /api/v1/identity/audit  { workspace_id, source, outputType, text }
  fastify.post<{ Body: { workspace_id?: string; source?: string; outputType?: string; text?: string } }>('/audit', async (req, reply) => {
    const { workspace_id, source, outputType, text } = req.body ?? {}
    if (!workspace_id || !source || !outputType || !text) {
      return reply.code(400).send({ success: false, error: 'workspace_id, source, outputType, text all required' })
    }
    if (!VALID_OUTPUT_TYPES.includes(outputType as OutputType)) {
      return reply.code(400).send({ success: false, error: `outputType must be one of: ${VALID_OUTPUT_TYPES.join(', ')}` })
    }
    const result = await recordAudit(workspace_id, source, outputType as OutputType, text)
    return { success: true, data: result }
  })
}

export default identityRoutes
