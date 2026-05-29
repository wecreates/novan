/**
 * connector-openai.ts — real OpenAI handlers via raw fetch (no SDK).
 *
 * We avoid the openai SDK to keep the install lean — three endpoints
 * is little enough that direct fetch is clearer.
 *
 * Wired actions:
 *   - openai.chat_completion (draft, low risk — billed per token)
 *   - openai.embeddings      (draft, low risk)
 *   - openai.list_models     (read,  low risk)
 *
 * Cost-of-use guardrail: chat_completion + embeddings return token
 * counts in the result so the audit row captures real spend.
 *
 * `openai.image_generate` is declared in the connector def but not
 * implemented here — image generation has its own cost shape that
 * deserves a dedicated handler when wired.
 */
import type { ConnectorHandler } from './connectors.js'

const BASE = 'https://api.openai.com/v1'

async function call<T>(token: string, path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type':  'application/json',
      'authorization': `Bearer ${token}`,
    },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, init)
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`OpenAI ${resp.status}: ${txt.slice(0, 300)}`)
  }
  return resp.json() as Promise<T>
}

export const listModels: ConnectorHandler = async (ctx) => {
  const token = await ctx.getSecret()
  const data = await call<{ data: Array<{ id: string; created: number; owned_by: string }> }>(
    token, '/models', undefined, 'GET',
  )
  // Slim subset to keep audit row small
  return data.data.map(m => ({ id: m.id, created: m.created, ownedBy: m.owned_by }))
}

export const chatCompletion: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const model = String(params['model'] ?? 'gpt-4o-mini')
  const messages = params['messages']
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('params.messages required (array of {role, content})')
  }
  const temperature = typeof params['temperature'] === 'number' ? params['temperature'] : undefined
  const max_tokens = typeof params['max_tokens'] === 'number' ? params['max_tokens'] : undefined

  const data = await call<{
    id: string; model: string;
    choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  }>(token, '/chat/completions', {
    model, messages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens  !== undefined ? { max_tokens }  : {}),
  })

  // Return only the first choice's content + the usage (for cost tracking).
  // Full response would bloat the audit row.
  return {
    id:        data.id,
    model:     data.model,
    content:   data.choices[0]?.message.content ?? '',
    finish_reason: data.choices[0]?.finish_reason ?? 'unknown',
    usage:     data.usage,
  }
}

export const embeddings: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const model = String(params['model'] ?? 'text-embedding-3-small')
  const input = params['input']
  if (typeof input !== 'string' && !Array.isArray(input)) {
    throw new Error('params.input required (string or string[])')
  }
  const data = await call<{
    data: Array<{ index: number; embedding: number[] }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  }>(token, '/embeddings', { model, input })

  // Embeddings can be huge — return vector dimensions + count, NOT the
  // raw floats (those should be persisted separately if needed).
  return {
    model: data.model,
    count: data.data.length,
    dimensions: data.data[0]?.embedding.length ?? 0,
    usage: data.usage,
  }
}
