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
      .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[chat]', e.message); return null })
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
        case 'cancel_pending':
        case 'delegate_to_agency':
        case 'construct_business': {
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
      }).where(eq(chatActions.id, row.id)).catch((e: Error) => { console.error('[chat]', e.message); return null })
      return { success: true, data: { status: 'executed', result } }
    } catch (e) {
      await db.update(chatActions).set({
        status: 'failed',
        executedResult: { error: (e as Error).message },
        decidedBy: 'operator', decidedAt: Date.now(),
      }).where(eq(chatActions.id, row.id)).catch((e: Error) => { console.error('[chat]', e.message); return null })
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
      .catch((e: Error) => { console.error('[chat]', e.message); return null })
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

  // SSE chat turn — per-route rate limit caps a single IP/operator at 30
  // streams/minute. The global 200/min limit covers cheap reads; LLM
  // streams burn provider tokens so they get a tighter cap.
  fastify.post<{ Body: { workspace_id?: string; conversation_id?: string; message?: string; regenerate_from?: string; attachments?: unknown; prefer_provider?: string } }>('/stream', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.conversation_id || !b.message) {
      return reply.code(400).send({ success: false, error: 'workspace_id, conversation_id, message required' })
    }
    // Pre-validate attachments so we 400 instead of writing an SSE error frame.
    const { validateAttachments } = await import('../services/chat-attachments.js')
    const vres = validateAttachments(b.attachments)
    if (!vres.ok) return reply.code(400).send({ success: false, error: vres.reason })

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Track client-side disconnect so we stop billing for a stream the
    // operator already aborted. The SSE reader on the browser side calls
    // AbortController.abort() which closes the socket; we observe that
    // via the `close` event and flip cancelled=true.
    let cancelled = false
    req.raw.on('close', () => { cancelled = true })

    try {
      for await (const ev of chatTurn({
        workspaceId: b.workspace_id, conversationId: b.conversation_id, userMessage: b.message,
        ...(b.regenerate_from ? { regenerateFrom: b.regenerate_from } : {}),
        ...(vres.attachments?.length ? { attachments: vres.attachments } : {}),
        ...(b.prefer_provider ? { preferProvider: b.prefer_provider } : {}),
        isCancelled: () => cancelled,
      })) {
        if (cancelled) break
        reply.raw.write(`event: ${ev.event}\n`)
        reply.raw.write(`data: ${JSON.stringify(ev.data)}\n\n`)
      }
      if (cancelled) {
        reply.raw.write(`event: cancelled\n`)
        reply.raw.write(`data: ${JSON.stringify({ reason: 'client_aborted' })}\n\n`)
      }
    } catch (e) {
      reply.raw.write(`event: error\n`)
      reply.raw.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`)
    } finally {
      reply.raw.end()
    }
  })

  // Validate-and-echo an attachment. Client converts the user's File →
  // data URL, posts here, gets back the canonical shape it should include
  // on /stream. No binary storage server-side: the data URL travels with
  // the next /stream call and is decoded by the chosen LLM provider.
  fastify.post<{ Body: { workspace_id?: string; url?: string; mime?: string; kind?: string; name?: string; size_bytes?: number } }>('/attachments/validate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { validateAttachments } = await import('../services/chat-attachments.js')
    const item: Record<string, unknown> = { url: req.body.url, mime: req.body.mime, kind: req.body.kind }
    if (req.body.name)       item.name      = req.body.name
    if (req.body.size_bytes) item.sizeBytes = req.body.size_bytes
    const vres = validateAttachments([item])
    if (!vres.ok) return reply.code(400).send({ success: false, error: vres.reason })
    return { success: true, data: { attachment: vres.attachments?.[0] ?? null } }
  })

  // Export a conversation as markdown or JSON.
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string; format?: 'md' | 'json'; include_superseded?: 'true' | 'false'; include_audit?: 'true' | 'false' } }>('/conversations/:id/export', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const format = req.query.format === 'json' ? 'json' : 'md'

    const { conversations, messages } = await import('../db/schema.js')
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.workspaceId, ws), eq(conversations.id, req.params.id)))
      .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[chat]', e.message); return null })
    if (!conv) return reply.code(404).send({ success: false, error: 'conversation not found' })

    const rows = await db.select().from(messages)
      .where(and(eq(messages.workspaceId, ws), eq(messages.conversationId, req.params.id)))
      .catch(() => [])

    const { renderMarkdown, renderJson, exportFilename } = await import('../services/conversation-export.js')
    const opts = {
      includeSuperseded: req.query.include_superseded === 'true',
      includeAudit:      req.query.include_audit !== 'false',
    }

    const convExport = {
      id: conv.id, title: conv.title, createdAt: conv.createdAt,
      forkedFromConversationId: conv.forkedFromConversationId ?? null,
      forkedFromMessageId:      conv.forkedFromMessageId ?? null,
    }
    const filename = exportFilename(conv.title, Date.now(), format)

    if (format === 'json') {
      const body = renderJson(convExport, rows, opts)
      reply.header('Content-Type', 'application/json; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      return body
    } else {
      const body = renderMarkdown(convExport, rows, opts)
      reply.header('Content-Type', 'text/markdown; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      return reply.send(body)
    }
  })

  // Branch from a specific message → new conversation with shared history
  // up to and including the fork-point.
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string; fork_point_message_id?: string; title?: string } }>('/conversations/:id/fork', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const fp = req.body.fork_point_message_id
    if (!fp) return reply.code(400).send({ success: false, error: 'fork_point_message_id required' })
    const { forkConversation } = await import('../services/conversation-branching.js')
    const r = await forkConversation({
      workspaceId: ws, sourceConversationId: req.params.id,
      forkPointMessageId: fp, ...(req.body.title ? { title: req.body.title } : {}),
    })
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return reply.code(201).send({ success: true, data: { id: r.newConversationId, copied: r.copiedMessageCount } })
  })

  // Branch tree — all conversations sharing a branch root, given any node id.
  fastify.get<{ Params: { id: string }; Querystring: { workspace_id?: string } }>('/conversations/:id/branches', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { listBranchTree } = await import('../services/conversation-branching.js')
    return { success: true, data: await listBranchTree(ws, req.params.id) }
  })

  // Regenerate — supersede an assistant message and re-stream from the
  // user turn that produced it. Returns 202 + the new message id once
  // the regeneration row is queued; the actual streaming uses /stream.
  fastify.post<{ Params: { id: string }; Body: { workspace_id?: string } }>('/messages/:id/regenerate', async (req, reply) => {
    const ws = req.body.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const { regenerateMessage } = await import('../services/novan-chat.js')
    const r = await regenerateMessage(ws, req.params.id)
    if (!r.ok) return reply.code(400).send({ success: false, error: r.reason })
    return reply.code(202).send({ success: true, data: r })
  })

  // Search across conversations + message bodies. Returns matching
  // messages (with conversation context) so the operator can jump back
  // to a past discussion. Read-only ILIKE — no LLM call required.
  fastify.get<{ Querystring: { workspace_id?: string; q?: string; limit?: string } }>('/search', async (req, reply) => {
    const ws = req.query.workspace_id
    const q  = (req.query.q ?? '').trim()
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    if (q.length < 2) return { success: true, data: [] }
    const { searchChatMessages } = await import('../services/novan-chat.js')
    const limit = Math.min(Number(req.query.limit ?? 30), 100)
    return { success: true, data: await searchChatMessages(ws, q, limit) }
  })
}

export default chatRoutes
