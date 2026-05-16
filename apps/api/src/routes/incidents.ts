/**
 * Incident Routes — /api/v1/incidents
 *
 * GET  /                          — list incidents
 * POST /scan                      — run detector, open/update incidents from real signals
 * GET  /:id                       — single incident
 * GET  /:id/timeline              — incident timeline
 * POST /:id/acknowledge           — ack incident
 * POST /:id/resolve               — resolve incident
 * POST /:id/escalate              — escalate incident
 * POST /:id/repair-task           — create repair task linked to incident
 * GET  /stats                     — summary counts
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  scanAndOpenIncidents, listIncidents, getIncident,
  getIncidentTimeline, acknowledgeIncident, resolveIncident,
  escalateIncident, createRepairTaskForIncident,
} from '../services/incident-service.js'
import { db }                from '../db/client.js'
import { incidents }         from '../db/schema.js'
import { eq }                from 'drizzle-orm'

const incidentRoutes: FastifyPluginAsync = async (fastify) => {

  // GET /
  fastify.get<{
    Querystring: { workspace_id?: string; status?: string; limit?: string }
  }>('/', async (req, reply) => {
    const { workspace_id, status, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listIncidents(workspace_id, status, limit ? Number(limit) : 50)
    return { success: true, data }
  })

  // POST /scan
  fastify.post<{
    Body: { workspace_id?: string; workspaceId?: string }
  }>('/scan', async (req, reply) => {
    const workspaceId = req.body.workspace_id ?? req.body.workspaceId
    if (!workspaceId) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const result = await scanAndOpenIncidents(workspaceId)
    return { success: true, data: result }
  })

  // GET /stats
  fastify.get<{
    Querystring: { workspace_id?: string }
  }>('/stats', async (req, reply) => {
    const { workspace_id } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })

    const rows = await db.select({
      status: incidents.status, severity: incidents.severity,
    }).from(incidents).where(eq(incidents.workspaceId, workspace_id))

    const stats = {
      total:        rows.length,
      open:         rows.filter((r) => r.status === 'open').length,
      acknowledged: rows.filter((r) => r.status === 'acknowledged').length,
      mitigating:   rows.filter((r) => r.status === 'mitigating').length,
      resolved:     rows.filter((r) => r.status === 'resolved').length,
      escalated:    rows.filter((r) => r.status === 'escalated').length,
      emergency:    rows.filter((r) => r.severity === 'emergency').length,
      critical:     rows.filter((r) => r.severity === 'critical').length,
    }
    return { success: true, data: stats }
  })

  // GET /:id
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const inc = await getIncident(req.params.id)
    if (!inc) return reply.code(404).send({ success: false, error: 'Incident not found' })
    return { success: true, data: inc }
  })

  // GET /:id/timeline
  fastify.get<{ Params: { id: string } }>('/:id/timeline', async (req) => {
    const timeline = await getIncidentTimeline(req.params.id)
    return { success: true, data: timeline }
  })

  // POST /:id/acknowledge
  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; note?: string }
  }>('/:id/acknowledge', async (req, reply) => {
    const actor = req.body.actor ?? 'ops-user'
    const updated = await acknowledgeIncident(req.params.id, actor, req.body.note)
    if (!updated) return reply.code(404).send({ success: false, error: 'Incident not found' })
    return { success: true, data: updated }
  })

  // POST /:id/resolve
  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; note: string }
  }>('/:id/resolve', async (req, reply) => {
    const note = req.body.note
    if (!note) return reply.code(400).send({ success: false, error: 'resolution note required' })
    const actor = req.body.actor ?? 'ops-user'
    const updated = await resolveIncident(req.params.id, actor, note)
    if (!updated) return reply.code(404).send({ success: false, error: 'Incident not found' })
    return { success: true, data: updated }
  })

  // POST /:id/escalate
  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; reason: string }
  }>('/:id/escalate', async (req, reply) => {
    const reason = req.body.reason
    if (!reason) return reply.code(400).send({ success: false, error: 'escalation reason required' })
    const actor = req.body.actor ?? 'ops-user'
    const updated = await escalateIncident(req.params.id, actor, reason)
    if (!updated) return reply.code(404).send({ success: false, error: 'Incident not found' })
    return { success: true, data: updated }
  })

  // POST /:id/repair-task
  fastify.post<{
    Params: { id: string }
    Body:   { actor?: string; task_ref: string; approval_granted?: boolean }
  }>('/:id/repair-task', async (req, reply) => {
    const { task_ref, approval_granted } = req.body
    if (!task_ref) return reply.code(400).send({ success: false, error: 'task_ref required' })
    const actor = req.body.actor ?? 'ops-user'
    const result = await createRepairTaskForIncident(
      req.params.id, actor, task_ref, approval_granted === true,
    )
    if (!result.ok) return reply.code(409).send({ success: false, error: result.reason })
    return { success: true, data: result }
  })
}

export default incidentRoutes
