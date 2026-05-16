/**
 * Security Routes — /api/v1/security
 *
 * Secrets     : POST /secrets  GET /secrets  POST /secrets/:id/reveal  POST /secrets/:id/rotate  DELETE /secrets/:id
 * RBAC        : POST /rbac/grant  POST /rbac/revoke  POST /rbac/check  GET /rbac/members
 * Audits      : GET /audits  GET /audits/stats  POST /audits/scan  POST /audits/export  GET /audits/exports  GET /audits/integrity
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  storeSecret, revealSecret, rotateSecret, listSecrets, deleteSecret,
}                          from '../services/secrets-vault.js'
import {
  grantRole, revokeRole, authorize, listMembers, PERMISSIONS,
}                          from '../services/rbac.js'
import type { Role, Permission } from '../services/rbac.js'
import {
  listSecurityEvents, getSecurityStats, detectSuspiciousActivity,
  requestAuditExport, listAuditExports, verifyAuditIntegrity, recordSecurityEvent,
}                          from '../services/security-monitor.js'

const securityRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Secrets ──────────────────────────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; name?: string; value?: string; provider?: string; created_by?: string }
  }>('/secrets', async (req, reply) => {
    const { workspace_id, name, value, provider, created_by } = req.body
    if (!workspace_id || !name || !value) {
      return reply.code(400).send({ success: false, error: 'workspace_id, name, value required' })
    }
    const input: Parameters<typeof storeSecret>[0] = {
      workspaceId: workspace_id, name, value,
    }
    if (provider) input.provider = provider
    if (created_by) input.createdBy = created_by
    const id = await storeSecret(input)
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/secrets', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listSecrets(ws)
    return { success: true, data }
  })

  fastify.post<{
    Params: { id: string }
    Body:   { requested_by?: string; reason?: string }
  }>('/secrets/:id/reveal', async (req, reply) => {
    const { requested_by, reason } = req.body
    if (!requested_by || !reason) {
      return reply.code(400).send({ success: false, error: 'requested_by and reason required' })
    }
    try {
      const value = await revealSecret(req.params.id, requested_by, reason)
      if (value === null) return reply.code(404).send({ success: false, error: 'Secret not found' })
      return { success: true, data: { value } }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body:   { new_value?: string; rotated_by?: string }
  }>('/secrets/:id/rotate', async (req, reply) => {
    const { new_value, rotated_by } = req.body
    if (!new_value || !rotated_by) {
      return reply.code(400).send({ success: false, error: 'new_value and rotated_by required' })
    }
    const ok = await rotateSecret(req.params.id, new_value, rotated_by)
    if (!ok) return reply.code(404).send({ success: false, error: 'Secret not found' })
    return { success: true, data: { rotated: true } }
  })

  fastify.delete<{
    Params: { id: string }
    Querystring: { deleted_by?: string }
  }>('/secrets/:id', async (req, reply) => {
    const by = req.query.deleted_by ?? 'system'
    const ok = await deleteSecret(req.params.id, by)
    if (!ok) return reply.code(404).send({ success: false, error: 'Secret not found' })
    return { success: true, data: { deleted: true } }
  })

  // ── RBAC ─────────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      user_id?: string; workspace_id?: string; role?: Role
      granted_by?: string; extra_grants?: Permission[]
    }
  }>('/rbac/grant', async (req, reply) => {
    const { user_id, workspace_id, role, granted_by, extra_grants } = req.body
    if (!user_id || !workspace_id || !role || !granted_by) {
      return reply.code(400).send({ success: false, error: 'user_id, workspace_id, role, granted_by required' })
    }
    await grantRole(user_id, workspace_id, role, granted_by, extra_grants ?? [])
    return { success: true, data: { granted: true } }
  })

  fastify.post<{
    Body: { user_id?: string; workspace_id?: string; revoked_by?: string }
  }>('/rbac/revoke', async (req, reply) => {
    const { user_id, workspace_id, revoked_by } = req.body
    if (!user_id || !workspace_id || !revoked_by) {
      return reply.code(400).send({ success: false, error: 'user_id, workspace_id, revoked_by required' })
    }
    await revokeRole(user_id, workspace_id, revoked_by)
    return { success: true, data: { revoked: true } }
  })

  fastify.post<{
    Body: { user_id?: string; workspace_id?: string; permission?: Permission }
  }>('/rbac/check', async (req, reply) => {
    const { user_id, workspace_id, permission } = req.body
    if (!user_id || !workspace_id || !permission) {
      return reply.code(400).send({ success: false, error: 'user_id, workspace_id, permission required' })
    }
    const r = await authorize(user_id, workspace_id, permission)
    return { success: true, data: r }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/rbac/members', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listMembers(ws)
    return { success: true, data }
  })

  fastify.get('/rbac/permissions', async () => {
    return { success: true, data: PERMISSIONS }
  })

  // ── Audits ───────────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { workspace_id?: string; severity?: string; event_type?: string; limit?: string }
  }>('/audits', async (req, reply) => {
    const { workspace_id, severity, event_type, limit } = req.query
    if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { severity?: string; eventType?: string; limit?: number } = {}
    if (severity) opts.severity = severity
    if (event_type) opts.eventType = event_type
    if (limit) opts.limit = Number(limit)
    const data = await listSecurityEvents(workspace_id, opts)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/audits/stats', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getSecurityStats(ws)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string }
  }>('/audits/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await detectSuspiciousActivity(ws)
    return { success: true, data }
  })

  fastify.post<{
    Body: { workspace_id?: string; requested_by?: string; from_ts?: number; to_ts?: number; format?: 'json' | 'csv' }
  }>('/audits/export', async (req, reply) => {
    const { workspace_id, requested_by, from_ts, to_ts, format } = req.body
    if (!workspace_id || !requested_by || !from_ts || !to_ts) {
      return reply.code(400).send({ success: false, error: 'workspace_id, requested_by, from_ts, to_ts required' })
    }
    const input: Parameters<typeof requestAuditExport>[0] = {
      workspaceId: workspace_id, requestedBy: requested_by,
      fromTs: from_ts, toTs: to_ts,
    }
    if (format) input.format = format
    const id = await requestAuditExport(input)
    return { success: true, data: { exportId: id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/audits/exports', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await listAuditExports(ws)
    return { success: true, data }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/audits/integrity', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await verifyAuditIntegrity(ws)
    return { success: true, data }
  })

  // Manual security event recording (e.g. compliance actions from outside)
  fastify.post<{
    Body: {
      workspace_id?: string; user_id?: string; event_type?: string
      severity?: 'info' | 'warning' | 'critical'; resource?: string
      action?: string; outcome?: 'allowed' | 'denied' | 'recorded'
      context?: Record<string, unknown>
    }
  }>('/audits/record', async (req, reply) => {
    const { event_type, severity, outcome } = req.body
    if (!event_type || !severity || !outcome) {
      return reply.code(400).send({ success: false, error: 'event_type, severity, outcome required' })
    }
    const input: Parameters<typeof recordSecurityEvent>[0] = {
      eventType: event_type, severity, outcome,
    }
    if (req.body.workspace_id) input.workspaceId = req.body.workspace_id
    if (req.body.user_id) input.userId = req.body.user_id
    if (req.body.resource) input.resource = req.body.resource
    if (req.body.action) input.action = req.body.action
    if (req.body.context) input.context = req.body.context
    const id = await recordSecurityEvent(input)
    return { success: true, data: { id } }
  })
}

export default securityRoutes
