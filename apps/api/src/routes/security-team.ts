/**
 * Security Team Routes — /api/v1/security-team
 *
 * GET  /agents                — registered security agents
 * POST /scan                  — run full security team scan
 * GET  /findings              — list findings
 * GET  /findings/stats        — severity counts
 * POST /findings/:id/acknowledge
 * POST /findings/:id/resolve
 * POST /findings/:id/false-positive
 * POST /review-patch          — pre-dispatch patch security review
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listSecurityAgents, runSecurityScan, listFindings, getFindingStats,
  acknowledgeFinding, resolveFinding, markFalsePositive,
  reviewPatchBeforeDispatch, hasLaunchBlockingFindings,
}                          from '../services/security-team.js'

const securityTeamRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get('/agents', async () => {
    const data = await listSecurityAgents()
    return { success: true, data }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const result = await runSecurityScan(ws)
    return { success: true, data: result }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string } }>('/findings', async (req, reply) => {
    const { workspace_id, status } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listFindings(workspace_id, status)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/findings/stats', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getFindingStats(ws)
    return { success: true, data }
  })

  fastify.post<{
    Params: { id: string }; Body: { reviewer?: string }
  }>('/findings/:id/acknowledge', async (req) => {
    await acknowledgeFinding(req.params.id, req.body.reviewer ?? 'ops-user')
    return { success: true, data: { acknowledged: true } }
  })

  fastify.post<{
    Params: { id: string }; Body: { reviewer?: string; note?: string }
  }>('/findings/:id/resolve', async (req, reply) => {
    const note = req.body.note
    if (!note) return reply.code(400).send({ success: false, error: 'note required' })
    await resolveFinding(req.params.id, req.body.reviewer ?? 'ops-user', note)
    return { success: true, data: { resolved: true } }
  })

  fastify.post<{
    Params: { id: string }; Body: { reviewer?: string; note?: string }
  }>('/findings/:id/false-positive', async (req, reply) => {
    const note = req.body.note
    if (!note) return reply.code(400).send({ success: false, error: 'note required' })
    await markFalsePositive(req.params.id, req.body.reviewer ?? 'ops-user', note)
    return { success: true, data: { markedFalsePositive: true } }
  })

  fastify.post<{
    Body: { workspace_id?: string; file_path?: string; description?: string }
  }>('/review-patch', async (req, reply) => {
    const { workspace_id, file_path, description } = req.body
    if (!workspace_id || !file_path) {
      return reply.code(400).send({ success: false, error: 'workspace_id and file_path required' })
    }
    const result = await reviewPatchBeforeDispatch({
      workspaceId: workspace_id, filePath: file_path,
      description: description ?? '',
    })
    return { success: true, data: result }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/launch-blockers', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await hasLaunchBlockingFindings(ws)
    return { success: true, data }
  })
}

export default securityTeamRoutes
