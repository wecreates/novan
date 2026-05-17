/**
 * Operator routes — feedback, telemetry, health, plan-features.
 * Mounted at /api/v1/operator
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  submitFeedback, listFeedback, updateStatus, feedbackSummary,
  type FeedbackKind, type FeedbackStatus,
} from '../services/feedback.js'
import {
  track, topFeatures, frictionEvents, failureRates, sessionSummary,
  type TelemetryCategory, type TelemetryOutcome,
} from '../services/telemetry.js'
import { computeHealth, retentionSignals } from '../services/operator-health.js'
import { canUseFeature, listPlans, getWorkspacePlan, type Feature } from '../services/plan-features.js'

const operatorRoutes: FastifyPluginAsync = async (fastify) => {

  // ─── Feedback ──────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; kind?: string; title?: string; body?: string;
      surface?: string; severity?: string; context?: Record<string, unknown>;
      reported_by?: string;
    }
  }>('/feedback', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.kind || !b.title) {
      return reply.code(400).send({ success: false, error: 'workspace_id, kind, title required' })
    }
    const id = await submitFeedback({
      workspaceId: b.workspace_id,
      kind:        b.kind as FeedbackKind,
      title:       b.title,
      ...(b.body       !== undefined ? { body:       b.body       } : {}),
      ...(b.surface    !== undefined ? { surface:    b.surface    } : {}),
      ...(b.severity   !== undefined ? { severity:   b.severity as 'low' | 'normal' | 'high' | 'critical' } : {}),
      ...(b.context    !== undefined ? { context:    b.context    } : {}),
      ...(b.reported_by!== undefined ? { reportedBy: b.reported_by } : {}),
    })
    return { success: true, data: { id } }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string; kind?: string; limit?: string } }>('/feedback', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const opts: { status?: FeedbackStatus; kind?: FeedbackKind; limit?: number } = {}
    if (req.query.status) opts.status = req.query.status as FeedbackStatus
    if (req.query.kind)   opts.kind   = req.query.kind   as FeedbackKind
    if (req.query.limit)  opts.limit  = Number(req.query.limit)
    return { success: true, data: await listFeedback(ws, opts) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string } }>('/feedback/:id/status', async (req, reply) => {
    if (!req.body.workspace_id || !req.body.status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    await updateStatus(req.params.id, req.body.workspace_id, req.body.status as FeedbackStatus)
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/feedback/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await feedbackSummary(ws) }
  })

  // ─── Telemetry ─────────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; category?: string; name?: string;
      surface?: string; outcome?: string; duration_ms?: number;
      attributes?: Record<string, unknown>;
    }
  }>('/telemetry', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.category || !b.name) {
      return reply.code(400).send({ success: false, error: 'workspace_id, category, name required' })
    }
    await track({
      workspaceId: b.workspace_id,
      category:    b.category as TelemetryCategory,
      name:        b.name,
      ...(b.surface     !== undefined ? { surface:    b.surface }    : {}),
      ...(b.outcome     !== undefined ? { outcome:    b.outcome as TelemetryOutcome }    : {}),
      ...(b.duration_ms !== undefined ? { durationMs: b.duration_ms } : {}),
      ...(b.attributes  !== undefined ? { attributes: b.attributes } : {}),
    })
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/telemetry/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const [features, friction, failures, session] = await Promise.all([
      topFeatures(ws), frictionEvents(ws), failureRates(ws), sessionSummary(ws),
    ])
    return { success: true, data: { topFeatures: features, friction, failureRates: failures, session } }
  })

  // ─── Operator health ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/health', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await computeHealth(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/retention', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await retentionSignals(ws) }
  })

  // ─── Plan / feature gating ────────────────────────────────────────────────
  fastify.get('/plans', async () => ({ success: true, data: await listPlans() }))

  fastify.get<{ Querystring: { workspace_id?: string } }>('/plan', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await getWorkspacePlan(ws) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; feature?: string } }>('/feature-check', async (req, reply) => {
    const { workspace_id, feature } = req.query
    if (!workspace_id || !feature) return reply.code(400).send({ success: false, error: 'workspace_id, feature required' })
    return { success: true, data: await canUseFeature(workspace_id, feature as Feature) }
  })
}

export default operatorRoutes
