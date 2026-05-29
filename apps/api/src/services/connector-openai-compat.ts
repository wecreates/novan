/**
 * connector-openai-compat.ts — factory for OpenAI-compatible chat APIs.
 *
 * Many providers (Groq, OpenRouter, Mistral, Together, Fireworks, HF
 * Inference Router, etc.) speak the OpenAI Chat Completions wire format.
 * Same request body, same Bearer token, same response shape. Only the
 * base URL differs.
 *
 * This module builds connector handlers parameterized by base URL +
 * default model + optional extra-header function. Wiring a new
 * OpenAI-compat provider takes ~3 lines once the URL is verified.
 *
 * Honest scope:
 *   - We slim the response to the most useful subset (first choice +
 *     usage) like the OpenAI handler does.
 *   - Providers with quirks (e.g. OpenRouter requires `HTTP-Referer`)
 *     can pass `extraHeaders`.
 *   - Embeddings are excluded — not all OpenAI-compat providers expose
 *     them, and the request shape varies slightly.
 */
import type { ConnectorHandler } from './connectors.js'

export interface OpenAICompatConfig {
  baseUrl:       string                                            // e.g. 'https://api.groq.com/openai/v1'
  defaultModel:  string
  extraHeaders?: (ctx: Parameters<ConnectorHandler>[0]) => Record<string, string>
}

/** Build a chat-completion handler for an OpenAI-compatible endpoint. */
export function makeChatCompletionHandler(cfg: OpenAICompatConfig): ConnectorHandler {
  return async (ctx, params) => {
    const token = await ctx.getSecret()
    const model = String(params['model'] ?? cfg.defaultModel)
    const messages = params['messages']
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('params.messages required (array of {role, content})')
    }
    const temperature = typeof params['temperature'] === 'number' ? params['temperature'] : undefined
    const max_tokens  = typeof params['max_tokens']  === 'number' ? params['max_tokens']  : undefined

    const headers: Record<string, string> = {
      'content-type':  'application/json',
      'authorization': `Bearer ${token}`,
      ...(cfg.extraHeaders ? cfg.extraHeaders(ctx) : {}),
    }

    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({
        model, messages,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens  !== undefined ? { max_tokens }  : {}),
      }),
    })
    if (!resp.ok) {
      throw new Error(`${cfg.baseUrl} ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
    }
    const data = await resp.json() as {
      id?: string; model?: string;
      choices?: Array<{ message: { content: string }; finish_reason?: string }>;
      usage?:   { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
    return {
      id:        data.id ?? null,
      model:     data.model ?? model,
      content:   data.choices?.[0]?.message.content ?? '',
      finish_reason: data.choices?.[0]?.finish_reason ?? 'unknown',
      usage:     data.usage ?? null,
    }
  }
}

/** Generic list-models handler. Most OpenAI-compat providers expose /models. */
export function makeListModelsHandler(cfg: OpenAICompatConfig): ConnectorHandler {
  return async (ctx) => {
    const token = await ctx.getSecret()
    const headers: Record<string, string> = {
      'authorization': `Bearer ${token}`,
      ...(cfg.extraHeaders ? cfg.extraHeaders(ctx) : {}),
    }
    const resp = await fetch(`${cfg.baseUrl}/models`, { headers })
    if (!resp.ok) {
      throw new Error(`${cfg.baseUrl}/models ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`)
    }
    const data = await resp.json() as { data?: Array<{ id: string; owned_by?: string; created?: number }> }
    return (data.data ?? []).map(m => ({ id: m.id, ownedBy: m.owned_by ?? null, created: m.created ?? null }))
  }
}

// ── Provider-specific factories (verified URLs) ───────────────────────

export const groqChat = makeChatCompletionHandler({
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
})
export const groqListModels = makeListModelsHandler({
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
})

export const openrouterChat = makeChatCompletionHandler({
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-4o-mini',
  // OpenRouter recommends these headers for attribution + analytics
  extraHeaders: () => ({
    'http-referer': process.env['NOVAN_OPENROUTER_REFERER'] ?? 'https://github.com/your-org/novan',
    'x-title':      'Novan',
  }),
})
export const openrouterListModels = makeListModelsHandler({
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-4o-mini',
})

export const mistralChat = makeChatCompletionHandler({
  baseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-small-latest',
})
export const mistralListModels = makeListModelsHandler({
  baseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-small-latest',
})

// Hugging Face router — OpenAI-compatible chat endpoint
export const hfChat = makeChatCompletionHandler({
  baseUrl: 'https://router.huggingface.co/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct:fastest',
})
export const hfListModels = makeListModelsHandler({
  baseUrl: 'https://router.huggingface.co/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct:fastest',
})
