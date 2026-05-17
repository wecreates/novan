/**
 * Reality anchoring routes — /api/v1/truth
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  declare, setStatus, list, sweepStale, summary,
  type AssumptionCategory, type AssumptionStatus,
} from '../services/assumption-tracker.js'
import { check, classifyEpistemic, type Evidence, type Criticality } from '../services/ground-truth-engine.js'
import { scanDrift, listWarnings, resolveWarning }   from '../services/drift-detector.js'
import { applyCorrections }                          from '../services/reality-correction.js'

const truthRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Assumptions ────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; category?: string; statement?: string
      evidence_refs?: Array<{ table: string; id: string; extract: string }>
      confidence?: number; source?: string
    }
  }>('/assumptions', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.category || !b.statement || !b.source) {
      return reply.code(400).send({ success: false, error: 'workspace_id, category, statement, source required' })
    }
    const id = await declare({
      workspaceId: b.workspace_id,
      category: b.category as AssumptionCategory,
      statement: b.statement, source: b.source,
      ...(b.evidence_refs !== undefined ? { evidenceRefs: b.evidence_refs } : {}),
      ...(b.confidence    !== undefined ? { confidence:   b.confidence }    : {}),
    })
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string; category?: string; limit?: string } }>('/assumptions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { status?: AssumptionStatus; category?: AssumptionCategory; limit?: number } = {}
    if (req.query.status)   opts.status = req.query.status as AssumptionStatus
    if (req.query.category) opts.category = req.query.category as AssumptionCategory
    if (req.query.limit)    opts.limit = Number(req.query.limit)
    return { success: true, data: await list(ws, opts) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string; evidence_refs?: Array<{ table: string; id: string; extract: string }>; reason?: string } }>('/assumptions/:id/status', async (req, reply) => {
    const { workspace_id, status, evidence_refs, reason } = req.body
    if (!workspace_id || !status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    return { success: true, data: await setStatus(workspace_id, req.params.id, status as AssumptionStatus, {
      ...(evidence_refs !== undefined ? { evidenceRefs: evidence_refs } : {}),
      ...(reason !== undefined ? { reason } : {}),
    }) }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/assumptions/sweep-stale', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await sweepStale(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/assumptions/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await summary(ws) }
  })

  // ── Ground truth check ────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; decision_id?: string; criticality?: string; evidence?: Evidence[]
    }
  }>('/ground-truth/check', async (req, reply) => {
    const { workspace_id, decision_id, criticality, evidence } = req.body
    if (!workspace_id || !decision_id || !criticality || !Array.isArray(evidence)) {
      return reply.code(400).send({ success: false, error: 'workspace_id, decision_id, criticality, evidence[] required' })
    }
    return { success: true, data: await check({ workspaceId: workspace_id, decisionId: decision_id, criticality: criticality as Criticality, evidence }) }
  })

  fastify.post<{
    Body: {
      confidence?: number; has_verified_evidence?: boolean
      has_model_generation?: boolean; is_forecast?: boolean
    }
  }>('/ground-truth/classify', async (req, reply) => {
    const b = req.body
    if (typeof b.confidence !== 'number') return reply.code(400).send({ success: false, error: 'confidence required' })
    return { success: true, data: classifyEpistemic({
      confidence:          b.confidence,
      hasVerifiedEvidence: b.has_verified_evidence ?? false,
      hasModelGeneration:  b.has_model_generation ?? false,
      isForecast:          b.is_forecast ?? false,
    }) }
  })

  // ── Drift ──────────────────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/drift/scan', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await scanDrift(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: 'open' | 'acknowledged' | 'resolved' } }>('/drift/warnings', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listWarnings(ws, req.query.status ?? 'open') }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: 'acknowledged' | 'resolved' } }>('/drift/warnings/:id/status', async (req, reply) => {
    const { workspace_id, status } = req.body
    if (!workspace_id || !status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    return { success: true, data: await resolveWarning(workspace_id, req.params.id, status) }
  })

  // ── Reality correction ────────────────────────────────────────────────
  fastify.post<{ Body: { workspace_id?: string } }>('/correct', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await applyCorrections(ws) }
  })
}

export default truthRoutes
