/**
 * Learning Runtime Routes — /api/v1/learning-runtime
 *
 * GET  /failures                  — list failure memory
 * GET  /successful-fixes          — list verified fixes
 * GET  /stats                     — aggregate stats (risky files, agent rollback rates)
 * POST /check                     — pre-fix check (allow/warn/block)
 * POST /record-failure            — record a real failure with evidence
 * POST /record-success            — record a verified successful fix
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  listFailures, listSuccessfulFixes, getLearningStats,
  checkBeforePatch, recordFailure, recordSuccessfulFix,
}                          from '../services/failure-memory.js'
import type { FailureType, RootCauseClass } from '../services/failure-memory.js'

const learningRuntimeRoutes: FastifyPluginAsync = async (fastify) => {

  fastify.get<{ Querystring: { workspace_id?: string; type?: string; blocked?: string; limit?: string } }>(
    '/failures', async (req, reply) => {
      const { workspace_id, type, blocked, limit } = req.query
      if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
      const opts: { type?: string; blocked?: boolean; limit?: number } = {}
      if (type) opts.type = type
      if (blocked === 'true') opts.blocked = true
      if (limit) opts.limit = Number(limit)
      const data = await listFailures(workspace_id, opts)
      return { success: true, data }
    },
  )

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>(
    '/successful-fixes', async (req, reply) => {
      const { workspace_id, limit } = req.query
      if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
      const data = await listSuccessfulFixes(workspace_id, limit ? Number(limit) : 50)
      return { success: true, data }
    },
  )

  fastify.get<{ Querystring: { workspace_id?: string } }>(
    '/stats', async (req, reply) => {
      const { workspace_id } = req.query
      if (!workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
      const data = await getLearningStats(workspace_id)
      return { success: true, data }
    },
  )

  fastify.post<{
    Body: {
      workspace_id?: string; failure_type?: string; root_cause_class?: string
      target_ref?: string; error_message?: string
    }
  }>('/check', async (req, reply) => {
    const { workspace_id, failure_type, root_cause_class, target_ref, error_message } = req.body
    if (!workspace_id || !failure_type || !root_cause_class || !target_ref || !error_message) {
      return reply.code(400).send({ success: false, error: 'workspace_id, failure_type, root_cause_class, target_ref, error_message required' })
    }
    const result = await checkBeforePatch({
      workspaceId:    workspace_id,
      failureType:    failure_type as FailureType,
      rootCauseClass: root_cause_class as RootCauseClass,
      targetRef:      target_ref,
      errorMessage:   error_message,
    })
    return { success: true, data: result }
  })

  fastify.post<{
    Body: {
      workspace_id?: string; failure_type?: string; root_cause_class?: string
      target_ref?: string; target_kind?: string; error_message?: string
      agent_id?: string; evidence_ids?: string[]; attempted_fix_id?: string
    }
  }>('/record-failure', async (req, reply) => {
    const { workspace_id, failure_type, root_cause_class, target_ref, target_kind, error_message, agent_id, evidence_ids, attempted_fix_id } = req.body
    if (!workspace_id || !failure_type || !root_cause_class || !target_ref || !target_kind || !error_message) {
      return reply.code(400).send({ success: false, error: 'workspace_id, failure_type, root_cause_class, target_ref, target_kind, error_message required' })
    }
    if (!evidence_ids || evidence_ids.length === 0) {
      return reply.code(400).send({ success: false, error: 'evidence_ids required (real source-table row IDs)' })
    }
    try {
      const input: Parameters<typeof recordFailure>[0] = {
        workspaceId:    workspace_id,
        failureType:    failure_type as FailureType,
        rootCauseClass: root_cause_class as RootCauseClass,
        targetRef:      target_ref,
        targetKind:     target_kind,
        errorMessage:   error_message,
        evidenceIds:    evidence_ids,
      }
      if (agent_id) input.agentId = agent_id
      if (attempted_fix_id) input.attemptedFixId = attempted_fix_id
      const result = await recordFailure(input)
      return { success: true, data: result }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{
    Body: {
      workspace_id?: string; failure_signature?: string; fix_description?: string
      target_ref?: string; agent_id?: string
      verification_evidence_ids?: string[]; patch_record_ids?: string[]
    }
  }>('/record-success', async (req, reply) => {
    const { workspace_id, failure_signature, fix_description, target_ref, agent_id, verification_evidence_ids, patch_record_ids } = req.body
    if (!workspace_id || !failure_signature || !fix_description || !target_ref) {
      return reply.code(400).send({ success: false, error: 'workspace_id, failure_signature, fix_description, target_ref required' })
    }
    try {
      const input: Parameters<typeof recordSuccessfulFix>[0] = {
        workspaceId:             workspace_id,
        failureSignature:        failure_signature,
        fixDescription:          fix_description,
        targetRef:               target_ref,
        verificationEvidenceIds: verification_evidence_ids ?? [],
        patchRecordIds:          patch_record_ids ?? [],
      }
      if (agent_id) input.agentId = agent_id
      const result = await recordSuccessfulFix(input)
      return { success: true, data: result }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })
}

export default learningRuntimeRoutes
