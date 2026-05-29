/**
 * Issues routes — /api/v1/issues/*
 * The unified engineering issue ledger.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  createOrAppendIssue, diagnoseIssue, linkProposal, linkPatch,
  verifyIssue, closeIssue, rejectIssue, getIssue, listIssues, issueStats,
  autoIngestSignals,
  type IssueStatus, type IssueSeverity, type IssueSource, type EvidenceItem,
} from '../services/issues.js'

const issuesRoutes: FastifyPluginAsync = async (fastify) => {

  // List + filter
  fastify.get<{
    Querystring: { workspace_id?: string; status?: string; severity?: string; source?: string; limit?: string }
  }>('/', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listIssues(ws, {
      ...(req.query.status   ? { status:   req.query.status   as IssueStatus   } : {}),
      ...(req.query.severity ? { severity: req.query.severity as IssueSeverity } : {}),
      ...(req.query.source   ? { source:   req.query.source   as IssueSource   } : {}),
      ...(req.query.limit    ? { limit:    Number(req.query.limit) } : {}),
    }) }
  })

  // Stats — counts grouped by (status, severity)
  fastify.get<{ Querystring: { workspace_id?: string } }>('/stats', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await issueStats(ws) }
  })

  // Single
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/:id', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await getIssue(ws, req.params.id)
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Create (also dedupes via fingerprint)
  fastify.post<{
    Body: {
      workspace_id?: string
      symptom?:       string
      source?:        string
      severity?:      string
      affected_systems?: string[]
      root_cause?:    string
      evidence?:      EvidenceItem[]
      proposed_fix?:  string
      verification_plan?: string
      rollback_plan?: string
      risk_level?:    string
      created_by?:    string
      fingerprint?:   string
    }
  }>('/', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.symptom || !b.source) {
      return reply.code(400).send({ success: false, error: 'workspace_id, symptom, source required' })
    }
    const r = await createOrAppendIssue({
      workspaceId: b.workspace_id,
      symptom:     b.symptom,
      source:      b.source as IssueSource,
      ...(b.severity         ? { severity:         b.severity as IssueSeverity } : {}),
      ...(b.affected_systems ? { affectedSystems:  b.affected_systems } : {}),
      ...(b.root_cause       ? { rootCause:        b.root_cause } : {}),
      ...(b.evidence         ? { evidence:         b.evidence } : {}),
      ...(b.proposed_fix     ? { proposedFix:      b.proposed_fix } : {}),
      ...(b.verification_plan ? { verificationPlan: b.verification_plan } : {}),
      ...(b.rollback_plan    ? { rollbackPlan:     b.rollback_plan } : {}),
      ...(b.risk_level       ? { riskLevel:        b.risk_level as 'low'|'medium'|'high'|'critical' } : {}),
      ...(b.created_by       ? { createdBy:        b.created_by } : {}),
      ...(b.fingerprint      ? { fingerprint:      b.fingerprint } : {}),
    })
    return reply.code(r.deduped ? 200 : 201).send({ success: true, data: r })
  })

  // Diagnose — fill root_cause/proposed_fix/etc, transition to 'diagnosed'
  fastify.post<{
    Params: { id: string }
    Body: {
      workspace_id?: string
      root_cause?: string; proposed_fix?: string; verification_plan?: string
      rollback_plan?: string; risk_level?: string
      affected_systems?: string[]; diagnosed_by?: string
    }
  }>('/:id/diagnose', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.root_cause) {
      return reply.code(400).send({ success: false, error: 'workspace_id, root_cause required' })
    }
    const row = await diagnoseIssue(b.workspace_id, req.params.id, {
      rootCause: b.root_cause,
      ...(b.proposed_fix      ? { proposedFix:      b.proposed_fix } : {}),
      ...(b.verification_plan ? { verificationPlan: b.verification_plan } : {}),
      ...(b.rollback_plan     ? { rollbackPlan:     b.rollback_plan } : {}),
      ...(b.risk_level        ? { riskLevel:        b.risk_level as 'low'|'medium'|'high'|'critical' } : {}),
      ...(b.affected_systems  ? { affectedSystems:  b.affected_systems } : {}),
      ...(b.diagnosed_by      ? { diagnosedBy:      b.diagnosed_by } : {}),
    })
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Link a code_proposals row
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; proposal_id?: string } }>('/:id/link-proposal', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.proposal_id) return reply.code(400).send({ success: false, error: 'workspace_id, proposal_id required' })
    const row = await linkProposal(b.workspace_id, req.params.id, b.proposal_id)
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Link a code_patches row (status → patched)
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; patch_id?: string } }>('/:id/link-patch', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.patch_id) return reply.code(400).send({ success: false, error: 'workspace_id, patch_id required' })
    const row = await linkPatch(b.workspace_id, req.params.id, b.patch_id)
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Verify (status → verified). Pass evidence array describing what passed.
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; evidence?: EvidenceItem[]; commit_sha?: string } }>('/:id/verify', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await verifyIssue(b.workspace_id, req.params.id, b.evidence ?? [], b.commit_sha)
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Close (must be 'verified' unless force=true)
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; closed_by?: string; force?: boolean } }>('/:id/close', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    try {
      const row = await closeIssue(b.workspace_id, req.params.id, b.closed_by ?? 'operator', { force: !!b.force })
      if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
      return { success: true, data: row }
    } catch (e) {
      return reply.code(409).send({ success: false, error: (e as Error).message })
    }
  })

  // Reject — terminal won't-fix
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; reason?: string; by?: string } }>('/:id/reject', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.reason) return reply.code(400).send({ success: false, error: 'workspace_id, reason required' })
    const row = await rejectIssue(b.workspace_id, req.params.id, b.reason, b.by ?? 'operator')
    if (!row) return reply.code(404).send({ success: false, error: 'issue not found' })
    return { success: true, data: row }
  })

  // Auto-ingest from incidents + cron.error events (last hour). Idempotent.
  fastify.post<{ Body: { workspace_id?: string } }>('/auto-ingest', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await autoIngestSignals(ws) }
  })

  // Auto-loop: diagnosed → proposed, patched → verified. Idempotent.
  fastify.post<{ Body: { workspace_id?: string } }>('/auto-loop', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { runAutoLoopFor } = await import('../services/issue-auto-loop.js')
    return { success: true, data: await runAutoLoopFor(ws) }
  })
}

export default issuesRoutes
