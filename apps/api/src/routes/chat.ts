/**
 * Chat routes — /api/v1/chat/*
 * SSE streaming + conversation CRUD.
 */
import type { FastifyPluginAsync } from 'fastify'
import {
  createConversation, listConversations, listMessages, archiveConversation,
  chatTurn,
} from '../services/novan-chat.js'

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
