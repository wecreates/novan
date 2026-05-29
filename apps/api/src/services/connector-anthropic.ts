/**
 * connector-anthropic.ts — real Anthropic Messages API via raw fetch.
 *
 * Auth: API key (sk-ant-…) stored in vault. Different header shape from
 * OpenAI: `x-api-key` + `anthropic-version`.
 *
 * Wired:
 *   - anthropic.messages    (chat completion equivalent; low risk, billed)
 *   - anthropic.list_models (read)
 *
 * Notes:
 *   - We expose the usage object so cost tracking works just like OpenAI.
 *   - Default model is the latest stable per docs at time of writing —
 *     operator can override via params.model.
 */
import type { ConnectorHandler } from './connectors.js'

const BASE = 'https://api.anthropic.com/v1'
const API_VERSION = '2023-06-01'

function headers(token: string): Record<string, string> {
  return {
    'x-api-key': token,
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
  }
}

export const messages: ConnectorHandler = async (ctx, params) => {
  const token = await ctx.getSecret()
  const model = String(params['model'] ?? 'claude-3-5-sonnet-latest')
  const msgs = params['messages']
  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error('params.messages required (array of {role, content})')
  }
  const max_tokens   = typeof params['max_tokens']   === 'number' ? params['max_tokens']   : 1024
  const temperature  = typeof params['temperature']  === 'number' ? params['temperature']  : undefined
  const system       = typeof params['system']       === 'string' ? params['system']       : undefined

  const resp = await fetch(`${BASE}/messages`, {
    method:  'POST',
    headers: headers(token),
    body:    JSON.stringify({
      model, messages: msgs, max_tokens,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(system      !== undefined ? { system }      : {}),
    }),
  })
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '')
    throw new Error(`Anthropic ${resp.status}: ${txt.slice(0, 300)}`)
  }
  const j = await resp.json() as {
    id: string; model: string; type: string; role: string;
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
    usage: { input_tokens: number; output_tokens: number };
  }
  // Concatenate text blocks (Anthropic returns an array of content blocks)
  const text = j.content.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n')
  return {
    id:     j.id,
    model:  j.model,
    content: text,
    stopReason: j.stop_reason,
    usage:  j.usage,
  }
}

/**
 * Anthropic doesn't expose a /models list endpoint on the public API
 * (as of 2025). We return a static list pinned in code — the values
 * match the docs at apidocs.anthropic.com. Operator can override the
 * list locally if they're using a private model gateway.
 */
export const listModels: ConnectorHandler = async () => {
  return [
    { id: 'claude-3-5-sonnet-latest', tier: 'sonnet' },
    { id: 'claude-3-5-haiku-latest',  tier: 'haiku'  },
    { id: 'claude-3-opus-latest',     tier: 'opus'   },
    { id: 'claude-3-haiku-20240307',  tier: 'haiku-legacy' },
  ]
}
