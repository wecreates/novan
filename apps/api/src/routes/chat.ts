/**
 * Chat routes — /api/v1/chat/*
 * SSE streaming + conversation CRUD.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  createConversation, listConversations, listMessages, archiveConversation,
  chatTurn,
} from '../services/novan-chat.js'
import { listAvailableProviders, configureProvider } from '../services/chat-providers.js'
import { db } from '../db/client.js'
import { chatActions } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import { dispatch as dispatchAction, type ActionType } from '../services/action-dispatcher.js'
import { createHorizon, type Horizon } from '../services/strategic-horizons.js'
import { setProposalStatus } from '../services/code-writer.js'
import { setAgentPaused } from '../services/trust-governance.js'

const chatRoutes: FastifyPluginAsync = async (fastify) => {

  // Create new conversation
  fastify.post<{ Body: { workspace_id?: string; title?: string } }>('/conversations', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const id = await createConversation(ws, req.body.title)
    return reply.code(201).send({ success: true, data: { id } })
  })

  fastify.get<{ Querystring: { workspace_id?: string; limit?: string } }>('/conversations', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listConversations(ws, req.query.limit ? Number(req.query.limit) : 30) }
  })

  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/conversations/:id/messages', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listMessages(ws, req.params.id) }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/conversations/:id/archive', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await archiveConversation(ws, req.params.id)
    return { success: true }
  })

  // ── Action suggestions (approve / reject / list) ─────────────────────
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/conversations/:id/actions', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const rows = await db.select().from(chatActions)
      .where(and(eq(chatActions.workspaceId, ws), eq(chatActions.conversationId, req.params.id)))
      .catch(() => [])
    return { success: true, data: rows }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; reason?: string; approval_token?: string } }>('/actions/:id/approve', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const row = await db.select().from(chatActions)
      .where(and(eq(chatActions.workspaceId, ws), eq(chatActions.id, req.params.id)))
      .limit(1).then(r => r[0]).catch(() => null)
    if (!row) return reply.code(404).send({ success: false, error: 'not found' })
    if (row.status !== 'suggested') return reply.code(400).send({ success: false, error: `already ${row.status}` })

    // Dispatch the action based on type
    let result: Record<string, unknown> = {}
    let executedActionId: string | null = null
    try {
      switch (row.actionType) {
        case 'engage_kill_switch': {
          // High-risk — operator must include approval_token
          if (req.body.approval_token !== 'OPERATOR_APPROVED') {
            return reply.code(400).send({ success: false, error: 'high-risk action requires approval_token=OPERATOR_APPROVED' })
          }
          const r = await dispatchAction({
            workspaceId: ws, type: 'engage_kill_switch' as ActionType,
            payload: { ...row.payload, approvalToken: 'OPERATOR_APPROVED' },
            requestedBy: 'chat-approval',
          })
          executedActionId = r.id; result = (r as unknown as Record<string, unknown>)
          break
        }
        case 'throttle_queue':
        case 'swap_provider_recommendation':
        case 'notify_operator':
        case 'record_decision':
        case 'cancel_pending': {
          const r = await dispatchAction({
            workspaceId: ws, type: row.actionType as ActionType,
            payload: row.payload, requestedBy: 'chat-approval',
          })
          executedActionId = r.id; result = (r as unknown as Record<string, unknown>)
          break
        }
        case 'pause_agent': {
          const name = String(row.payload['agentName'] ?? '')
          if (!name) throw new Error('agentName missing')
          await setAgentPaused(ws, name, true, 'chat-approval', String(row.payload['reason'] ?? ''))
          result = { paused: name }
          break
        }
        case 'approve_proposal': {
          const pid = String(row.payload['proposalId'] ?? '')
          if (!pid) throw new Error('proposalId missing')
          await setProposalStatus(ws, pid, 'approved')
          result = { proposalApproved: pid }
          break
        }
        case 'set_horizon': {
          const id = await createHorizon({
            workspaceId: ws,
            horizon: (row.payload['horizon'] as Horizon) ?? '90d',
            title: String(row.payload['title'] ?? 'Untitled horizon'),
            objectives: [{
              id: 'obj-1',
              statement: String(row.payload['objective'] ?? ''),
              metric: '', target: '', status: 'on_track',
            }],
          })
          result = { horizonId: id }
          break
        }
        case 'build_proposal': {
          // Pass through to a manual followup — operator triggers via /proposals
          result = { note: 'Use /proposals to trigger code-agent build', description: row.payload['description'] }
          break
        }
        default:
          return reply.code(400).send({ success: false, error: `unsupported action type: ${row.actionType}` })
      }
      await db.update(chatActions).set({
        status: 'executed',
        executedActionId,
        executedResult: result,
        decidedBy: 'operator', decidedAt: Date.now(),
        ...(req.body.reason ? { reason: req.body.reason } : {}),
      }).where(eq(chatActions.id, row.id)).catch(() => null)
      return { success: true, data: { status: 'executed', result } }
    } catch (e) {
      await db.update(chatActions).set({
        status: 'failed',
        executedResult: { error: (e as Error).message },
        decidedBy: 'operator', decidedAt: Date.now(),
      }).where(eq(chatActions.id, row.id)).catch(() => null)
      return reply.code(500).send({ success: false, error: (e as Error).message })
    }
  })

  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; reason?: string } }>('/actions/:id/reject', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    await db.update(chatActions).set({
      status: 'rejected',
      decidedBy: 'operator', decidedAt: Date.now(),
      ...(req.body.reason ? { reason: req.body.reason } : {}),
    }).where(and(eq(chatActions.workspaceId, ws), eq(chatActions.id, req.params.id)))
      .catch(() => null)
    return { success: true }
  })

  // ── Providers ────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { workspace_id?: string } }>('/providers', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    return { success: true, data: await listAvailableProviders(ws) }
  })

  fastify.post<{ Body: { workspace_id?: string; provider_id?: string; enabled?: boolean; priority?: number; label?: string } }>('/providers', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.provider_id) return reply.code(400).send({ success: false, error: 'workspace_id, provider_id required' })
    try {
      await configureProvider(b.workspace_id, b.provider_id, {
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.priority !== undefined ? { priority: b.priority } : {}),
        ...(b.label !== undefined ? { label: b.label } : {}),
      })
      return { success: true }
    } catch (e) {
      return reply.code(400).send({ success: false, error: (e as Error).message })
    }
  })

  // SSE chat turn
  fastify.post<{ Body: { workspace_id?: string; conversation_id?: string; message?: string } }>('/stream', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.conversation_id || !b.message) {
      return reply.code(400).send({ success: false, error: 'workspace_id, conversation_id, message required' })
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    try {
      for await (const ev of chatTurn({
        workspaceId: b.workspace_id, conversationId: b.conversation_id, userMessage: b.message,
      })) {
        reply.raw.write(`event: ${ev.event}\n`)
        reply.raw.write(`data: ${JSON.stringify(ev.data)}\n\n`)
      }
    } catch (e) {
      reply.raw.write(`event: error\n`)
      reply.raw.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`)
    } finally {
      reply.raw.end()
    }
  })
}

export default chatRoutes
