import type { RouteRequest, RouteResult, ModelSpec, ProviderId, TaskType } from './types.js'
import { enabledProviders } from './providers.js'
import { getProviderHealth } from './health.js'

// ─── Task routing strategy ────────────────────────────────────────────────────
// Each task type has an ordered preference list (provider:model).
// First healthy + enabled match wins. Rest become fallbacks.

const TASK_PREFERENCE: Record<TaskType, Array<{ provider: ProviderId; modelId: string }>> = {
  embedding: [
    { provider: 'ollama_local',  modelId: 'nomic-embed-text' },
    { provider: 'ollama_remote', modelId: 'nomic-embed-text' },
    { provider: 'openai',        modelId: 'text-embedding-3-small' },
  ],
  fast_chat: [
    { provider: 'groq',        modelId: 'llama3-70b-8192' },
    { provider: 'openrouter',  modelId: 'google/gemini-flash-1.5' },
    { provider: 'gemini',      modelId: 'gemini-1.5-flash' },
    { provider: 'openai',      modelId: 'gpt-4o-mini' },
    { provider: 'anthropic',   modelId: 'claude-3-haiku-20240307' },
    { provider: 'ollama_remote', modelId: 'llama3' },
    { provider: 'ollama_local',  modelId: 'llama3' },
  ],
  reasoning: [
    { provider: 'anthropic',     modelId: 'claude-3-5-sonnet-20241022' },
    { provider: 'openai',        modelId: 'gpt-4o' },
    { provider: 'gemini',        modelId: 'gemini-1.5-pro' },
    { provider: 'ollama_remote', modelId: 'llama3:70b' },
    { provider: 'groq',          modelId: 'llama3-70b-8192' },
  ],
  code: [
    { provider: 'anthropic',     modelId: 'claude-3-5-sonnet-20241022' },
    { provider: 'openai',        modelId: 'gpt-4o' },
    { provider: 'ollama_remote', modelId: 'llama3:70b' },
    { provider: 'openai',        modelId: 'gpt-4o-mini' },
    { provider: 'groq',          modelId: 'llama3-70b-8192' },
  ],
  vision: [
    { provider: 'openai',       modelId: 'gpt-4o' },
    { provider: 'anthropic',    modelId: 'claude-3-5-sonnet-20241022' },
    { provider: 'gemini',       modelId: 'gemini-1.5-flash' },
    { provider: 'openrouter',   modelId: 'google/gemini-flash-1.5' },
  ],
  summarize: [
    { provider: 'groq',        modelId: 'llama3-70b-8192' },
    { provider: 'gemini',      modelId: 'gemini-1.5-flash' },
    { provider: 'anthropic',   modelId: 'claude-3-haiku-20240307' },
    { provider: 'openai',      modelId: 'gpt-4o-mini' },
    { provider: 'ollama_remote', modelId: 'llama3' },
    { provider: 'ollama_local',  modelId: 'llama3' },
  ],
  classify: [
    { provider: 'groq',        modelId: 'llama3-8b-8192' },
    { provider: 'openrouter',  modelId: 'mistralai/mistral-7b-instruct' },
    { provider: 'openai',      modelId: 'gpt-4o-mini' },
    { provider: 'ollama_local', modelId: 'llama3' },
  ],
  extract: [
    { provider: 'groq',        modelId: 'llama3-70b-8192' },
    { provider: 'openai',      modelId: 'gpt-4o-mini' },
    { provider: 'anthropic',   modelId: 'claude-3-haiku-20240307' },
    { provider: 'ollama_remote', modelId: 'llama3' },
    { provider: 'ollama_local',  modelId: 'llama3' },
  ],
}

// ─── Route resolver ───────────────────────────────────────────────────────────

export async function resolveRoute(req: RouteRequest): Promise<RouteResult> {
  const { taskType, requireVision, preferProvider, maxCostUsd, promptTokensEst } = req

  const enabled = new Map(
    enabledProviders().flatMap((p) =>
      p.models.map((m) => [`${p.id}:${m.modelId}`, m] as [string, ModelSpec])
    )
  )

  const health = await getProviderHealth()
  const healthMap = new Map(health.map((h) => [h.provider, h]))

  // Build ordered candidate list
  let prefs = TASK_PREFERENCE[taskType] ?? TASK_PREFERENCE['fast_chat']!

  // If prefer override, bubble it to front
  if (preferProvider) {
    const match = prefs.filter((p) => p.provider === preferProvider)
    const rest  = prefs.filter((p) => p.provider !== preferProvider)
    prefs = [...match, ...rest]
  }

  const candidates: ModelSpec[] = []
  for (const { provider, modelId } of prefs) {
    const model = enabled.get(`${provider}:${modelId}`)
    if (!model) continue
    if (requireVision && !model.supportsVision) continue
    const h = healthMap.get(provider)
    if (h?.status === 'down') continue

    // Cost ceiling check
    if (maxCostUsd !== undefined) {
      const estCost = estimateCost(model, promptTokensEst, 512)
      if (estCost > maxCostUsd) continue
    }

    candidates.push(model)
  }

  if (candidates.length === 0) {
    // Absolute fallback: first enabled model regardless of health/cost
    const fallback = enabled.values().next().value as ModelSpec | undefined
    if (!fallback) throw new Error(`No provider available for task: ${taskType}`)
    return {
      provider: fallback.provider,
      model: fallback,
      fallbacks: [],
      estimatedCostUsd: estimateCost(fallback, promptTokensEst, 512),
    }
  }

  const [primary, ...fallbacks] = candidates
  return {
    provider: primary!.provider,
    model: primary!,
    fallbacks: fallbacks.slice(0, 3),
    estimatedCostUsd: estimateCost(primary!, promptTokensEst, 512),
  }
}

export function estimateCost(model: ModelSpec, promptTokens: number, outputTokens: number): number {
  return (promptTokens / 1000) * model.promptPer1k + (outputTokens / 1000) * model.outputPer1k
}
