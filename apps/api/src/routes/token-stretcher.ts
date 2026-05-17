/**
 * Token stretcher routes.
 *
 * GET  /token-stretcher/metrics?workspace_id=…  — aggregated metrics
 * POST /token-stretcher/purge                   — purge expired cache rows
 */
import type { FastifyPluginAsync } from 'fastify'
import { getMetrics, purgeExpired, stretch, type Message } from '../services/token-stretcher.js'

const tokenStretcherRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { workspace_id?: string } }>('/metrics', async (req, reply) => {
    const ws = req.query.workspace_id
    if (!ws) return reply.code(400).send({ success: false, error: 'workspace_id required' })
    const data = await getMetrics(ws)
    return { success: true, data }
  })

  fastify.post('/purge', async () => {
    const purged = await purgeExpired()
    return { success: true, data: { purged } }
  })

  /**
   * POST /chat — stretched chat completion.
   * Wraps the AI call with cache + compression + metrics.
   * Currently dispatches to Groq (only provider with free creds).
   */
  fastify.post<{
    Body: {
      workspace_id?: string
      model?:        string
      messages?:     Message[]
      task_type?:    string
      max_tokens?:   number
      temperature?:  number
      cache_ttl_ms?: number
    }
  }>('/chat', async (req, reply) => {
    const b = req.body
    if (!b.workspace_id || !b.model || !Array.isArray(b.messages) || b.messages.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'workspace_id, model, messages[] required',
      })
    }

    const groqKey = process.env['GROQ_API_KEY']
    if (!groqKey) {
      return reply.code(503).send({ success: false, error: 'GROQ_API_KEY not configured' })
    }

    const result = await stretch({
      workspaceId: b.workspace_id,
      model:       b.model,
      messages:    b.messages,
      ...(b.task_type    !== undefined ? { taskType:    b.task_type }    : {}),
      ...(b.max_tokens   !== undefined ? { maxTokens:   b.max_tokens }   : {}),
      ...(b.temperature  !== undefined ? { temperature: b.temperature }  : {}),
      ...(b.cache_ttl_ms !== undefined ? { cacheTtlMs:  b.cache_ttl_ms } : {}),
      call: async ({ model, messages, maxTokens, temperature }) => {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${groqKey}`,
          },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
          signal: AbortSignal.timeout(60_000),
        })
        const body = await res.json().catch(() => ({})) as Record<string, unknown>
        if (!res.ok) {
          throw new Error(`Groq ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
        }
        const choices = body['choices'] as Array<{ message?: { content?: string } }> | undefined
        const usage   = body['usage']   as { prompt_tokens?: number; completion_tokens?: number } | undefined
        return {
          content:        choices?.[0]?.message?.content ?? '',
          ...(usage?.prompt_tokens     !== undefined ? { promptTokens:   usage.prompt_tokens }     : {}),
          ...(usage?.completion_tokens !== undefined ? { responseTokens: usage.completion_tokens } : {}),
        }
      },
    }).catch((e: Error) => ({ error: e.message }))

    if ('error' in result) {
      return reply.code(502).send({ success: false, error: result.error })
    }
    return { success: true, data: result }
  })
}

export default tokenStretcherRoutes
