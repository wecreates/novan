import OpenAI from 'openai'
import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelSpec,
} from './types.js'
import { resolveRoute, estimateCost } from './routing.js'
import { getProvider } from './providers.js'
import { checkBudget, recordSpend } from './budget.js'
import { recordProviderResult, recordProviderLatency } from './health.js'
import { trackUsage } from './tracker.js'

// ─── OpenAI-compatible client factory ────────────────────────────────────────

function makeClient(model: ModelSpec): OpenAI {
  const provider = getProvider(model.provider)
  if (!provider) throw new Error(`Unknown provider: ${model.provider}`)

  const apiKey =
    model.provider === 'ollama_local' || model.provider === 'ollama_remote'
      ? 'ollama'                                        // Ollama doesn't need a key
      : (process.env[provider.apiKeyEnv] ?? 'missing')

  return new OpenAI({ apiKey, baseURL: provider.baseUrl })
}

// ─── Chat completion ──────────────────────────────────────────────────────────

export async function chat(req: CompletionRequest): Promise<CompletionResponse> {
  const route = await resolveRoute({
    taskType:        req.taskType,
    workspaceId:     req.workspaceId,
    promptTokensEst: estimatePromptTokens(req.messages),
    ...(hasImages(req.messages)   ? { requireVision:  true }               : {}),
    ...(req.preferProvider        ? { preferProvider: req.preferProvider }  : {}),
    ...(req.maxCostUsd !== undefined ? { maxCostUsd: req.maxCostUsd }      : {}),
  })

  // Budget check
  if (!checkBudget(req.workspaceId, route.estimatedCostUsd)) {
    throw new Error(`Budget limit reached for workspace ${req.workspaceId}`)
  }

  const candidates = [route.model, ...route.fallbacks]
  let lastError: Error | null = null

  for (const model of candidates) {
    const client = makeClient(model)
    const t0     = Date.now()
    try {
      const response = await client.chat.completions.create({
        model:       model.modelId,
        messages:    req.messages as OpenAI.ChatCompletionMessageParam[],
        max_tokens:  req.maxTokens  ?? model.maxOutputTokens,
        temperature: req.temperature ?? 0.7,
        stream:      false,
      })

      const latencyMs     = Date.now() - t0
      const promptTokens  = response.usage?.prompt_tokens     ?? 0
      const outputTokens  = response.usage?.completion_tokens ?? 0
      const costUsd       = estimateCost(model, promptTokens, outputTokens)
      const content       = response.choices[0]?.message?.content ?? ''

      recordProviderResult(model.provider, true)
      recordProviderLatency(model.provider, latencyMs)
      recordSpend(req.workspaceId, costUsd)

      await trackUsage({
        workspaceId:  req.workspaceId,
        provider:     model.provider,
        model:        model.modelId,
        promptTokens, outputTokens, costUsd, latencyMs,
        cached:       false,
        taskType:     req.taskType,
      })

      return {
        content, costUsd, latencyMs, promptTokens, outputTokens,
        provider: model.provider,
        model:    model.modelId,
        cached:   false,
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      recordProviderResult(model.provider, false)
    }
  }

  throw lastError ?? new Error('All providers failed')
}

// ─── Embedding ────────────────────────────────────────────────────────────────

export async function embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
  const route = await resolveRoute({
    taskType:        'embedding',
    workspaceId:     req.workspaceId,
    promptTokensEst: Math.ceil(req.text.length / 4),
  })

  const candidates = [route.model, ...route.fallbacks]
  let lastError: Error | null = null

  for (const model of candidates) {
    // Ollama uses native embedding endpoint, not OpenAI /embeddings
    if (model.provider === 'ollama_local' || model.provider === 'ollama_remote') {
      const result = await ollamaEmbed(req, model)
      if (result) return result
      continue
    }

    const client = makeClient(model)
    const t0     = Date.now()
    try {
      const response = await client.embeddings.create({
        model: model.modelId,
        input: req.text,
        ...(req.dimensions ? { dimensions: req.dimensions } : {}),
      })

      const latencyMs    = Date.now() - t0
      const promptTokens = response.usage?.prompt_tokens ?? 0
      const costUsd      = estimateCost(model, promptTokens, 0)
      const embedding    = response.data[0]?.embedding ?? []

      recordProviderResult(model.provider, true)
      recordProviderLatency(model.provider, latencyMs)
      recordSpend(req.workspaceId, costUsd)

      await trackUsage({
        workspaceId: req.workspaceId, provider: model.provider, model: model.modelId,
        promptTokens, outputTokens: 0, costUsd, latencyMs, cached: false, taskType: 'embedding',
      })

      return { embedding, provider: model.provider, model: model.modelId, promptTokens, costUsd, latencyMs }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      recordProviderResult(model.provider, false)
    }
  }

  throw lastError ?? new Error('All embedding providers failed')
}

// ─── Ollama native embedding ──────────────────────────────────────────────────

async function ollamaEmbed(req: EmbeddingRequest, model: ModelSpec): Promise<EmbeddingResponse | null> {
  const provider = getProvider(model.provider)
  if (!provider) return null
  const t0 = Date.now()
  try {
    const res = await fetch(`${provider.baseUrl.replace('/v1', '')}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: model.modelId, prompt: req.text }),
    })
    if (!res.ok) { recordProviderResult(model.provider, false); return null }
    const json = await res.json() as { embedding?: number[] }
    const embedding = json.embedding ?? []
    const latencyMs = Date.now() - t0
    recordProviderResult(model.provider, true)
    recordProviderLatency(model.provider, latencyMs)
    await trackUsage({
      workspaceId: req.workspaceId, provider: model.provider, model: model.modelId,
      promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs, cached: false, taskType: 'embedding',
    })
    return { embedding, provider: model.provider, model: model.modelId, promptTokens: 0, costUsd: 0, latencyMs }
  } catch {
    recordProviderResult(model.provider, false)
    return null
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimatePromptTokens(messages: CompletionRequest['messages']): number {
  return messages.reduce((acc, m) => {
    if (typeof m.content === 'string') return acc + Math.ceil(m.content.length / 4)
    if (Array.isArray(m.content)) {
      return acc + m.content.reduce((a, p) => a + (p.text ? Math.ceil(p.text.length / 4) : 300), 0)
    }
    return acc
  }, 0)
}

function hasImages(messages: CompletionRequest['messages']): boolean {
  return messages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  )
}
