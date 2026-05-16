import type {
  RoutingRequest,
  RoutingDecision,
  ProviderHealth,
  ProviderConfig,
  ModelConfig,
  CompletionResult,
  EmbeddingResult,
} from './types.js'
import { getEnabledProviders, DEFAULT_PROVIDERS } from './config.js'

export class ProviderRouter {
  private providers: ProviderConfig[]
  private health: Map<string, ProviderHealth> = new Map()

  constructor(providers?: ProviderConfig[]) {
    this.providers = providers ?? DEFAULT_PROVIDERS
  }

  /** Select best provider+model for a request. */
  route(req: RoutingRequest): RoutingDecision {
    const enabled = getEnabledProviders(this.providers)
    const tier = req.tier ?? (req.taskType === 'embedding' ? 'lightweight' : 'standard')

    // Filter to healthy providers (or all if no health data yet)
    const candidates = enabled.filter((p) => {
      const h = this.health.get(p.name)
      return !h || h.healthy
    })

    // Prefer specific provider if requested and available
    if (req.preferProvider) {
      const preferred = candidates.find((p) => p.name === req.preferProvider)
      if (preferred) {
        const model = this.selectModel(preferred, tier, req)
        if (model) return this.buildDecision(preferred, model, 'preferred_provider')
      }
    }

    // Find cheapest capable model at requested tier
    let best: { provider: ProviderConfig; model: ModelConfig } | null = null
    let bestCost = Infinity

    for (const provider of candidates) {
      const model = this.selectModel(provider, tier, req)
      if (!model) continue
      const cost = (model.costPer1kInput + model.costPer1kOutput) / 2
      if (cost < bestCost) {
        bestCost = cost
        best = { provider, model }
      }
    }

    // Fallback: any available model from any candidate
    if (!best) {
      for (const provider of candidates) {
        const model = provider.models[0]
        if (model) {
          best = { provider, model }
          break
        }
      }
    }

    if (!best) throw new Error('No AI providers available')

    return this.buildDecision(best.provider, best.model, 'cost_optimized')
  }

  private selectModel(
    provider: ProviderConfig,
    tier: string,
    req: RoutingRequest,
  ): ModelConfig | undefined {
    const tierModels = provider.models.filter((m) => m.tier === tier)
    const candidates = tierModels.length > 0 ? tierModels : provider.models

    return candidates.find((m) => {
      if (req.tools?.length && !m.supportsTools) return false
      if (req.taskType === 'vision' && !m.supportsVision) return false
      if (req.taskType === 'embedding') {
        return m.id.includes('embed') || m.id.includes('nomic')
      }
      return !m.id.includes('embed') && !m.id.includes('nomic')
    })
  }

  private buildDecision(
    provider: ProviderConfig,
    model: ModelConfig,
    reason: string,
  ): RoutingDecision {
    return {
      provider: provider.name,
      model: model.id,
      tier: model.tier,
      estimatedCostUsd: (model.costPer1kInput + model.costPer1kOutput) * 0.5,
      reason,
    }
  }

  /** Execute a completion request against the routed provider. */
  async complete(request: RoutingRequest): Promise<CompletionResult> {
    const decision = this.route(request)
    if (decision.provider === 'anthropic') {
      return this.callAnthropic(decision, request)
    } else if (decision.provider === 'ollama') {
      return this.callOllama(decision, request)
    } else {
      return this.callOpenAI(decision, request)
    }
  }

  private async callOpenAI(decision: RoutingDecision, req: RoutingRequest): Promise<CompletionResult> {
    const apiKey = process.env['OPENAI_API_KEY'] ?? ''
    const baseUrl = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'
    const start = Date.now()

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: decision.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1000,
        temperature: req.temperature ?? 0.7,
        stream: false,
      }),
    })

    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`)
    const data = await res.json() as Record<string, unknown> & {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const latency = Date.now() - start
    this.updateHealth(decision.provider, true, latency)

    const promptTokens = data.usage?.prompt_tokens ?? 0
    const outputTokens = data.usage?.completion_tokens ?? 0
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: decision.model,
      provider: decision.provider,
      promptTokens,
      outputTokens,
      usage: { promptTokens, outputTokens },
      costUsd: 0,
      latencyMs: latency,
      cached: false,
      finishReason: 'stop',
    }
  }

  private async callAnthropic(decision: RoutingDecision, req: RoutingRequest): Promise<CompletionResult> {
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
    const start = Date.now()

    const systemMsg = req.messages.find((m) => m.role === 'system')?.content ?? undefined
    const msgs = req.messages.filter((m) => m.role !== 'system')

    const body: Record<string, unknown> = {
      model: decision.model,
      messages: msgs,
      max_tokens: req.maxTokens ?? 1000,
    }
    if (systemMsg) body['system'] = systemMsg

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`)
    const data = await res.json() as Record<string, unknown> & {
      content?: Array<{ text?: string }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    const latency = Date.now() - start
    this.updateHealth(decision.provider, true, latency)

    const promptTokens = data.usage?.input_tokens ?? 0
    const outputTokens = data.usage?.output_tokens ?? 0
    return {
      content: data.content?.[0]?.text ?? '',
      model: decision.model,
      provider: decision.provider,
      promptTokens,
      outputTokens,
      usage: { promptTokens, outputTokens },
      costUsd: 0,
      latencyMs: latency,
      cached: false,
      finishReason: 'stop',
    }
  }

  private async callOllama(decision: RoutingDecision, req: RoutingRequest): Promise<CompletionResult> {
    const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
    const start = Date.now()
    const prompt = req.messages.map((m) => `${m.role}: ${m.content}`).join('\n')

    const res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: decision.model, prompt, stream: false }),
    })

    if (!res.ok) throw new Error(`Ollama error ${res.status}`)
    const data = await res.json() as Record<string, unknown> & { response?: string }
    const latency = Date.now() - start
    this.updateHealth(decision.provider, true, latency)

    return {
      content: data.response ?? '',
      model: decision.model,
      provider: decision.provider,
      promptTokens: 0,
      outputTokens: 0,
      usage: { promptTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: latency,
      cached: false,
      finishReason: 'stop',
    }
  }

  /** Generate embeddings for text using the appropriate provider. */
  async embed(text: string, model?: string): Promise<EmbeddingResult> {
    const req: RoutingRequest = {
      taskType: 'embedding',
      tier: 'lightweight',
      messages: [{ role: 'user', content: text }],
    }
    const decision = this.route(req)
    const resolvedModel = model ?? decision.model
    const start = Date.now()

    if (decision.provider === 'ollama') {
      const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
      const res = await fetch(`${baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: resolvedModel, prompt: text }),
      })
      if (!res.ok) throw new Error(`Ollama embed error ${res.status}`)
      const data = await res.json() as Record<string, unknown> & { embedding?: number[] }
      const latency = Date.now() - start
      this.updateHealth(decision.provider, true, latency)
      return { provider: decision.provider, model: resolvedModel, embedding: data.embedding ?? [], promptTokens: 0, costUsd: 0, latencyMs: latency }
    }

    // Default: OpenAI-compatible embeddings
    const apiKey = process.env['OPENAI_API_KEY'] ?? ''
    const baseUrl = process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1'
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: resolvedModel, input: text }),
    })
    if (!res.ok) throw new Error(`OpenAI embed error ${res.status}: ${await res.text()}`)
    const data = await res.json() as Record<string, unknown> & {
      data?: Array<{ embedding?: number[] }>
      usage?: { prompt_tokens?: number }
    }
    const latency = Date.now() - start
    this.updateHealth(decision.provider, true, latency)
    const promptTokens = data.usage?.prompt_tokens ?? 0
    return {
      provider: decision.provider,
      model: resolvedModel,
      embedding: data.data?.[0]?.embedding ?? [],
      promptTokens,
      costUsd: 0,
      latencyMs: latency,
    }
  }

  /** Update health state for a provider. */
  updateHealth(
    name: string,
    healthy: boolean,
    latencyMs?: number,
    errorMessage?: string,
  ): void {
    const entry: ProviderHealth = {
      name: name as ProviderHealth['name'],
      healthy,
      lastCheckedAt: Date.now(),
    }
    if (latencyMs !== undefined) entry.latencyMs = latencyMs
    if (errorMessage !== undefined) entry.errorMessage = errorMessage
    this.health.set(name, entry)
  }

  getHealth(): ProviderHealth[] {
    return Array.from(this.health.values())
  }

  listProviders() {
    return getEnabledProviders(this.providers).map((p) => ({
      name: p.name,
      enabled: p.enabled,
      priority: p.priority,
      models: p.models.map((m) => ({ id: m.id, displayName: m.displayName, tier: m.tier })),
      health: this.health.get(p.name) ?? null,
    }))
  }
}

/** Singleton for simple use cases. */
export const defaultRouter = new ProviderRouter()
