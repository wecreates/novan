/**
 * Remote Endpoint Client — handles all communication with private GPU servers.
 *
 * Supported provider types:
 *   ollama       — Ollama server (OpenAI-compat + native /api/tags)
 *   vllm         — vLLM OpenAI-compatible server
 *   localai      — LocalAI server
 *   tgi          — Text Generation Inference (HuggingFace)
 *   openai_compat — Any OpenAI-compatible server
 *   runpod       — RunPod serverless/pod endpoint
 *   vastai       — Vast.ai GPU instance
 *   lambda       — Lambda Labs GPU VM
 *
 * All requests use configurable timeouts. Auth is built from API key or
 * custom headers. Model discovery is provider-type-aware. Streaming uses
 * native fetch with SSE passthrough.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RemoteEndpointConfig {
  id:               string
  name:             string
  type:             string
  baseUrl:          string
  apiKey?:          string | null       // already decrypted
  customHeaders?:   Record<string, string> | null  // already decrypted
  modelIds:         string[]
  maxContextTokens: number
  promptPer1kUsd:   number
  outputPer1kUsd:   number
  timeoutMs:        number
}

export interface DiscoveredModel {
  id:           string
  name:         string
  contextLength: number | null
  quantization: string | null
  sizeBytes:    number | null
}

export interface RemoteCompletionRequest {
  model:       string
  messages:    Array<{ role: string; content: string }>
  maxTokens?:  number
  temperature?: number
  stream?:     boolean
}

export interface RemoteCompletionResult {
  content:      string
  promptTokens: number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  model:        string
}

export interface HealthCheckResult {
  status:    'healthy' | 'degraded' | 'down'
  latencyMs: number
  error?:    string
  models?:   string[]
}

// ─── Auth header builder ──────────────────────────────────────────────────────

export function buildAuthHeaders(ep: RemoteEndpointConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
  if (ep.apiKey) {
    headers['Authorization'] = `Bearer ${ep.apiKey}`
  }
  if (ep.customHeaders) {
    Object.assign(headers, ep.customHeaders)
  }
  return headers
}

// ─── Model discovery ──────────────────────────────────────────────────────────

/**
 * Auto-discovers available models from the endpoint using provider-specific APIs.
 * Falls back gracefully if discovery isn't supported.
 */
export async function discoverModels(ep: RemoteEndpointConfig): Promise<DiscoveredModel[]> {
  const headers = buildAuthHeaders(ep)
  const signal  = AbortSignal.timeout(ep.timeoutMs)

  switch (ep.type) {
    case 'ollama':
      return discoverOllama(ep.baseUrl, headers, signal)
    case 'tgi':
      return discoverTgi(ep.baseUrl, headers, signal)
    default:
      // vllm, localai, openai_compat, runpod, vastai, lambda — all OpenAI-compat
      return discoverOpenAICompat(ep.baseUrl, headers, signal)
  }
}

async function discoverOllama(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  // Try native Ollama list endpoint first
  const url = `${baseUrl.replace(/\/v1\/?$/, '')}/api/tags`
  const res  = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`)
  const json = await res.json() as {
    models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string }; model?: string }>
  }
  return (json.models ?? []).map((m) => ({
    id:           m.name ?? m.model ?? 'unknown',
    name:         m.name ?? m.model ?? 'unknown',
    contextLength: null,
    quantization: m.details?.quantization_level ?? null,
    sizeBytes:    m.size ?? null,
  }))
}

async function discoverTgi(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  // TGI exposes /info with model info
  const url = `${baseUrl.replace(/\/$/, '')}/info`
  const res  = await fetch(url, { headers, signal })
  if (!res.ok) {
    // Fall back to OpenAI-compat if TGI is running with that mode enabled
    return discoverOpenAICompat(baseUrl, headers, signal)
  }
  const json = await res.json() as {
    model_id?: string; max_total_tokens?: number; model_dtype?: string
  }
  const id = json.model_id ?? 'unknown'
  return [{ id, name: id, contextLength: json.max_total_tokens ?? null, quantization: json.model_dtype ?? null, sizeBytes: null }]
}

async function discoverOpenAICompat(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DiscoveredModel[]> {
  const base = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')
  const url  = `${base}/v1/models`
  const res  = await fetch(url, { headers, signal })
  if (!res.ok) throw new Error(`/v1/models returned ${res.status}`)
  const json = await res.json() as {
    data?: Array<{ id: string; object?: string; created?: number }>
    models?: Array<{ id: string }>
  }
  const items = json.data ?? json.models ?? []
  return items.map((m) => ({
    id:           m.id,
    name:         m.id,
    contextLength: null,
    quantization:  null,
    sizeBytes:     null,
  }))
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkEndpointHealth(ep: RemoteEndpointConfig): Promise<HealthCheckResult> {
  const t0     = Date.now()
  const signal = AbortSignal.timeout(Math.min(ep.timeoutMs, 8_000))
  const headers = buildAuthHeaders(ep)

  try {
    const models = await discoverModels({ ...ep, timeoutMs: Math.min(ep.timeoutMs, 8_000) })
    const latencyMs = Date.now() - t0
    const status: HealthCheckResult['status'] = latencyMs > 5_000 ? 'degraded' : 'healthy'
    return { status, latencyMs, models: models.map((m) => m.id) }
  } catch {
    // discoverModels failed — try a lighter ping
    try {
      const base = ep.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')
      const ping = ep.type === 'ollama' ? `${base}/api/version` : `${base}/v1/models`
      const res  = await fetch(ping, { headers, signal })
      const latencyMs = Date.now() - t0
      return {
        status: res.ok ? 'healthy' : res.status >= 500 ? 'down' : 'degraded',
        latencyMs,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      }
    } catch (pingErr) {
      return {
        status:    'down',
        latencyMs: Date.now() - t0,
        error:     pingErr instanceof Error ? pingErr.message : String(pingErr),
      }
    }
  }
}

// ─── Chat completion ──────────────────────────────────────────────────────────

export async function remoteChat(
  ep:  RemoteEndpointConfig,
  req: RemoteCompletionRequest,
): Promise<RemoteCompletionResult> {
  const headers = buildAuthHeaders(ep)
  const signal  = AbortSignal.timeout(ep.timeoutMs)
  const base    = ep.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')
  const url     = ep.type === 'tgi'
    ? `${base}/v1/chat/completions`    // TGI also supports OpenAI-compat
    : `${base}/v1/chat/completions`

  const t0 = Date.now()

  const body: Record<string, unknown> = {
    model:    req.model,
    messages: req.messages,
    stream:   false,
    ...(req.maxTokens   !== undefined ? { max_tokens:   req.maxTokens }   : {}),
    ...(req.temperature !== undefined ? { temperature:  req.temperature } : {}),
  }

  const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Remote endpoint ${ep.name} returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string }; text?: string }>
    usage?:   { prompt_tokens?: number; completion_tokens?: number }
  }

  const latencyMs     = Date.now() - t0
  const content       = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? ''
  const promptTokens  = json.usage?.prompt_tokens     ?? estimateTokens(req.messages.map((m) => m.content).join(' '))
  const outputTokens  = json.usage?.completion_tokens ?? estimateTokens(content)
  const costUsd       = (promptTokens / 1000) * ep.promptPer1kUsd + (outputTokens / 1000) * ep.outputPer1kUsd

  return { content, promptTokens, outputTokens, costUsd, latencyMs, model: req.model }
}

// ─── Streaming chat ───────────────────────────────────────────────────────────

export interface StreamChunk {
  content: string
  done:    boolean
  model?:  string | undefined
}

/**
 * Streams a chat completion from a remote endpoint.
 * Returns an async generator that yields SSE-parsed chunks.
 * Works for all OpenAI-compatible servers (Ollama, vLLM, LocalAI, TGI, etc.)
 */
export async function* remoteChatStream(
  ep:  RemoteEndpointConfig,
  req: RemoteCompletionRequest,
): AsyncGenerator<StreamChunk> {
  const headers = { ...buildAuthHeaders(ep), Accept: 'text/event-stream' }
  const signal  = AbortSignal.timeout(ep.timeoutMs)
  const base    = ep.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '')

  // Ollama also supports /api/chat with stream:true (native)
  const useNativeOllama = ep.type === 'ollama'
  const url = useNativeOllama
    ? `${base}/api/chat`
    : `${base}/v1/chat/completions`

  const body = useNativeOllama
    ? { model: req.model, messages: req.messages, stream: true }
    : {
        model: req.model, messages: req.messages, stream: true,
        ...(req.maxTokens   !== undefined ? { max_tokens:   req.maxTokens }   : {}),
        ...(req.temperature !== undefined ? { temperature:  req.temperature } : {}),
      }

  const res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) })
  if (!res.ok || !res.body) {
    throw new Error(`Stream request to ${ep.name} failed: HTTP ${res.status}`)
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) { yield { content: '', done: true }; break }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        if (useNativeOllama) {
          // Ollama native: each line is a JSON object
          try {
            const chunk = JSON.parse(trimmed) as {
              message?: { content?: string }
              done?: boolean
              model?: string
            }
            if (chunk.done) { yield { content: '', done: true }; return }
            yield { content: chunk.message?.content ?? '', done: false, model: chunk.model }
          } catch { /* ignore malformed */ }
        } else {
          // OpenAI SSE: data: {...} or data: [DONE]
          if (!trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') { yield { content: '', done: true }; return }
          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>
              model?: string
            }
            const delta = chunk.choices?.[0]?.delta?.content ?? ''
            const finished = chunk.choices?.[0]?.finish_reason !== null && chunk.choices?.[0]?.finish_reason !== undefined
            yield { content: delta, done: finished, model: chunk.model }
            if (finished) return
          } catch { /* ignore malformed */ }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => null)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Returns a human-readable label for a provider type. */
export function endpointTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    ollama:        'Ollama',
    vllm:          'vLLM',
    localai:       'LocalAI',
    tgi:           'TGI (HuggingFace)',
    openai_compat: 'OpenAI-Compatible',
    runpod:        'RunPod',
    vastai:        'Vast.ai',
    lambda:        'Lambda Labs',
  }
  return labels[type] ?? type
}

/** All supported endpoint types */
export const ENDPOINT_TYPES = [
  { value: 'ollama',        label: 'Ollama' },
  { value: 'vllm',          label: 'vLLM' },
  { value: 'localai',       label: 'LocalAI' },
  { value: 'tgi',           label: 'Text Generation Inference' },
  { value: 'openai_compat', label: 'OpenAI-Compatible' },
  { value: 'runpod',        label: 'RunPod' },
  { value: 'vastai',        label: 'Vast.ai' },
  { value: 'lambda',        label: 'Lambda Labs' },
] as const
