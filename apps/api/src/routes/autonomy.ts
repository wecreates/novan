/**
 * Autonomy completion routes — /api/v1/autonomy/*
 *
 * Bundles routes for: actions, revenue, recommendation feedback,
 * inbound messages, strategic horizons, cron budgets.
 */
import type { FastifyPluginAsync } from 'fastify'
import { dispatch, listRecent as listActions, summary as actionSummary, type ActionType } from '../services/action-dispatcher.js'
import { recordRevenue, revenueSummary, revenueByWorkflow, recentRevenue } from '../services/revenue.js'
import { submitFeedback, feedbackOnChain, feedbackSummary, type FeedbackAction } from '../services/recommendation-feedback.js'
import { ingest as ingestInbound, listRecent as listInbound, markProcessed, summary as inboundSummary, type Channel, type Intent } from '../services/inbound.js'
import { createHorizon, updateObjective, listHorizons, setStatus as setHorizonStatus, sweepDueReviews, type Horizon, type HorizonStatus, type Objective } from '../services/strategic-horizons.js'
import { listBudgets, checkBudget } from '../services/cron-budget.js'
import { trueRoi } from '../services/economic-intelligence.js'

const autonomyRoutes: FastifyPluginAsync = async (fastify) => {

  // ── Actions ──────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; type?: string; subject_id?: string
      payload?: Record<string, unknown>; requested_by?: string
    }
  }>('/actions/dispatch', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.type || !b.requested_by) {
      return reply.code(400).send({ success: false, error: 'workspace_id, type, requested_by required' })
    }
    return { success: true, data: await dispatch({
      workspaceId: b.workspace_id, type: b.type as ActionType,
      ...(b.subject_id !== undefined ? { subjectId: b.subject_id } : {}),
      payload: b.payload ?? {}, requestedBy: b.requested_by,
    }) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; status?: string; limit?: string } }>('/actions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listActions(ws, {
      ...(req.query.status ? { status: req.query.status as 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' } : {}),
      ...(req.query.limit ? { limit: Number(req.query.limit) } : {}),
    }) }
  })

  fastify.get<{ Querystring: { workspace_id?: string } }>('/actions/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await actionSummary(ws) }
  })

  // ── Revenue ──────────────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; source?: string; amount_usd?: number
      currency?: string; customer_ref?: string; workflow_run_id?: string
      occurred_at?: number; metadata?: Record<string, unknown>
    }
  }>('/revenue', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.source || typeof b.amount_usd !== 'number') {
      return reply.code(400).send({ success: false, error: 'workspace_id, source, amount_usd required' })
    }
    const id = await recordRevenue({
      workspaceId: b.workspace_id, source: b.source, amountUsd: b.amount_usd,
      ...(b.currency        !== undefined ? { currency:      b.currency }        : {}),
      ...(b.customer_ref    !== undefined ? { customerRef:   b.customer_ref }    : {}),
      ...(b.workflow_run_id !== undefined ? { workflowRunId: b.workflow_run_id } : {}),
      ...(b.occurred_at     !== undefined ? { occurredAt:    b.occurred_at }     : {}),
      ...(b.metadata        !== undefined ? { metadata:      b.metadata }        : {}),
    })
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/revenue/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await revenueSummary(ws, req.query.window_days ? Number(req.query.window_days) : 30) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/revenue/by-workflow', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await revenueByWorkflow(ws, req.query.window_days ? Number(req.query.window_days) : 30) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/revenue/recent', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await recentRevenue(ws, req.query.limit ? Number(req.query.limit) : 50) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/roi/true', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await trueRoi(ws, req.query.window_days ? Number(req.query.window_days) : 30) }
  })

  // ── Recommendation feedback ──────────────────────────────────────────
  fastify.post<{
    Body: { workspace_id?: string; chain_id?: string; action?: string; reason?: string; operator_id?: string }
  }>('/recommendation-feedback', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.chain_id || !b.action) {
      return reply.code(400).send({ success: false, error: 'workspace_id, chain_id, action required' })
    }
    return { success: true, data: await submitFeedback({
      workspaceId: b.workspace_id, chainId: b.chain_id, action: b.action as FeedbackAction,
      ...(b.reason      !== undefined ? { reason:     b.reason }      : {}),
      ...(b.operator_id !== undefined ? { operatorId: b.operator_id } : {}),
    }) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; chain_id?: string } }>('/recommendation-feedback', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws || !req.query.chain_id) return reply.code(400).send({ success: false, error: 'workspace_id, chain_id required' })
    return { success: true, data: await feedbackOnChain(ws, req.query.chain_id) }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/recommendation-feedback/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await feedbackSummary(ws, req.query.window_days ? Number(req.query.window_days) : 30) }
  })

  // ── Inbound messages ─────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; channel?: string; external_id?: string
      from_addr?: string; subject?: string; body?: string
      received_at?: number; metadata?: Record<string, unknown>
    }
  }>('/inbound', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.channel || !b.body) {
      return reply.code(400).send({ success: false, error: 'workspace_id, channel, body required' })
    }
    return reply.code(201).send({ success: true, data: await ingestInbound({
      workspaceId: b.workspace_id, channel: b.channel as Channel, body: b.body,
      ...(b.external_id !== undefined ? { externalId: b.external_id } : {}),
      ...(b.from_addr   !== undefined ? { fromAddr:   b.from_addr }   : {}),
      ...(b.subject     !== undefined ? { subject:    b.subject }     : {}),
      ...(b.received_at !== undefined ? { receivedAt: b.received_at } : {}),
      ...(b.metadata    !== undefined ? { metadata:   b.metadata }    : {}),
    }) })
  })

  fastify.get<{ Querystring: { workspace_id?: string; channel?: string; intent?: string; limit?: string } }>('/inbound', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listInbound(ws, {
      ...(req.query.channel ? { channel: req.query.channel as Channel } : {}),
      ...(req.query.intent  ? { intent:  req.query.intent as Intent }  : {}),
      ...(req.query.limit   ? { limit:   Number(req.query.limit) }     : {}),
    }) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/inbound/:id/processed', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await markProcessed(ws, req.params.id)
    return { success: true }
  })

  fastify.get<{ Querystring: { workspace_id?: string; window_days?: string } }>('/inbound/summary', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await inboundSummary(ws, req.query.window_days ? Number(req.query.window_days) : 7) }
  })

  // ── Strategic horizons ────────────────────────────────────────────────
  fastify.post<{
    Body: {
      workspace_id?: string; horizon?: string; title?: string
      objectives?: Objective[]; constraints?: Array<{ id: string; statement: string }>
      review_at?: number
    }
  }>('/horizons', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.horizon || !b.title) {
      return reply.code(400).send({ success: false, error: 'workspace_id, horizon, title required' })
    }
    const id = await createHorizon({
      workspaceId: b.workspace_id, horizon: b.horizon as Horizon, title: b.title,
      ...(b.objectives  !== undefined ? { objectives:  b.objectives }  : {}),
      ...(b.constraints !== undefined ? { constraints: b.constraints } : {}),
      ...(b.review_at   !== undefined ? { reviewAt:    b.review_at }   : {}),
    })
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; horizon?: string; status?: string } }>('/horizons', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listHorizons(ws, {
      ...(req.query.horizon ? { horizon: req.query.horizon as Horizon } : {}),
      ...(req.query.status  ? { status:  req.query.status  as HorizonStatus } : {}),
    }) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; objective?: Objective } }>('/horizons/:id/objective', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws || !req.body.objective) return reply.code(400).send({ success: false, error: 'workspace_id, objective required' })
    await updateObjective(ws, req.params.id, req.body.objective)
    return { success: true }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; status?: string } }>('/horizons/:id/status', async (req, reply) => {
    const { workspace_id, status } = req.body
    if (!workspace_id || !status) return reply.code(400).send({ success: false, error: 'workspace_id, status required' })
    await setHorizonStatus(workspace_id, req.params.id, status as HorizonStatus)
    return { success: true }
  })

  fastify.post<{ Body: { workspace_id?: string } }>('/horizons/sweep-due', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await sweepDueReviews(ws) }
  })

  // ── Cron budgets ─────────────────────────────────────────────────────
  fastify.get('/cron-budgets', async () => ({ success: true, data: await listBudgets() }))

  fastify.get<{ Querystring: { name?: string } }>('/cron-budgets/check', async (req, reply) => {
    const name = req.query.name
    if (!name) return reply.code(400).send({ success: false, error: 'name required' })
    return { success: true, data: await checkBudget(name) }
  })

  // ── DR drill ────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/dr/drill', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { drDrill } = await import('../services/dr-drill.js')
    return { success: true, data: await drDrill(ws) }
  })
}

export default autonomyRoutes
