/**
 * chat-providers.ts — Multi-provider chat streaming abstraction.
 *
 * Provider families:
 *   - OpenAI-compatible (Groq, OpenAI, OpenRouter, Together, Mistral,
 *     DeepSeek, Fireworks, Cerebras, etc.) — same `/v1/chat/completions`
 *     SSE shape
 *   - Anthropic — `/v1/messages` with different event types
 *   - Gemini — `/v1beta/models/:model:streamGenerateContent`
 *
 * Reads enabled providers from provider_configs table.
 * Honest scope: API keys must be set as env vars (PROVIDER_API_KEY format).
 *   Operator adds rows to provider_configs to enable; vault-encrypted
 *   keys are read via secrets-vault when available, env var otherwise.
 */
import { db } from '../db/client.js'
import { providerConfigs } from '../db/schema.js'
import { and, eq } from 'drizzle-orm'
import {
  type ChatAttachment,
  materializeOpenAI, materializeAnthropic, materializeGemini,
} from './chat-attachments.js'
import { fetchWithRetry } from './provider-retry.js'

export type ChatRole = 'system' | 'user' | 'assistant'
export interface ChatMsg {
  role:         ChatRole
  content:      string
  /** Multimodal inputs on user messages. Ignored on system/assistant. */
  attachments?: ChatAttachment[]
}
export interface StreamChunk {
  delta: string
  done: boolean
  /** Extended-thinking deltas (Anthropic). Operator-visible reasoning the
   *  model produced before the final answer. Surfaced separately so the
   *  UI can render it in a distinct panel rather than mixing it with the
   *  spoken response. */
  thinking?: string
}
export interface StreamResult {
  content: string
  tokens: number
  costUsd: number
  provider: string
  model: string
  /** Anthropic prompt-cache accounting. cache_read_input_tokens are
   *  billed at 10% of the base input rate; cache_creation_input_tokens
   *  at 125%. Surfaced so the operator dashboard can show actual savings. */
  cacheReadTokens?: number
  cacheCreationTokens?: number
  /** Total thinking tokens, when extended-thinking was requested. */
  thinkingTokens?: number
}

// Provider family registry — id → handler
type Family = 'openai' | 'anthropic' | 'gemini'

interface ProviderDef {
  id:       string                          // provider_id used in providerConfigs
  family:   Family
  baseUrl:  string
  defaultModel: string
  envVar:   string                          // env var name for API key
  costPer1kTokens?: number                  // rough cost estimate for token accounting
}

// Hard-coded defaults; operator may override via provider_configs row.
export const KNOWN_PROVIDERS: ProviderDef[] = [
  { id: 'groq',         family: 'openai',   baseUrl: 'https://api.groq.com/openai/v1',                  defaultModel: 'llama-3.3-70b-versatile', envVar: 'GROQ_API_KEY',         costPer1kTokens: 0.00059 },
  { id: 'openai',       family: 'openai',   baseUrl: 'https://api.openai.com/v1',                       defaultModel: 'gpt-4o-mini',             envVar: 'OPENAI_API_KEY',       costPer1kTokens: 0.000150 },
  { id: 'openrouter',   family: 'openai',   baseUrl: 'https://openrouter.ai/api/v1',                    defaultModel: 'meta-llama/llama-3.3-70b-instruct', envVar: 'OPENROUTER_API_KEY', costPer1kTokens: 0.00059 },
  { id: 'together',     family: 'openai',   baseUrl: 'https://api.together.xyz/v1',                     defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', envVar: 'TOGETHER_API_KEY', costPer1kTokens: 0.00088 },
  { id: 'mistral',      family: 'openai',   baseUrl: 'https://api.mistral.ai/v1',                       defaultModel: 'mistral-large-latest',    envVar: 'MISTRAL_API_KEY',      costPer1kTokens: 0.002 },
  { id: 'deepseek',     family: 'openai',   baseUrl: 'https://api.deepseek.com/v1',                     defaultModel: 'deepseek-chat',           envVar: 'DEEPSEEK_API_KEY',     costPer1kTokens: 0.00014 },
  { id: 'fireworks',    family: 'openai',   baseUrl: 'https://api.fireworks.ai/inference/v1',           defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', envVar: 'FIREWORKS_API_KEY', costPer1kTokens: 0.0009 },
  { id: 'cerebras',     family: 'openai',   baseUrl: 'https://api.cerebras.ai/v1',                      defaultModel: 'llama-3.3-70b',           envVar: 'CEREBRAS_API_KEY',     costPer1kTokens: 0.00085 },
  // R146 — Claude Sonnet 3.5 was retired Jan 2026 and the `-latest`
  // suffix convention was dropped at the 4.6 generation (model IDs are
  // now pinned snapshots, no evergreen pointer). `claude-sonnet-4-6` is
  // the current GA Sonnet ($3/$15 MTok, supports prompt-cache + extended
  // thinking, matches what streamAnthropic already negotiates).
  { id: 'anthropic',    family: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',                   defaultModel: 'claude-sonnet-4-6',        envVar: 'ANTHROPIC_API_KEY',   costPer1kTokens: 0.003 },
  // R146 — gemini-2.0-flash listed in :listModels but returns 404 from
  // :streamGenerateContent for newer API keys; gemini-2.5-flash is the
  // current generally-available flash tier and works for both endpoints.
  { id: 'gemini',       family: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash',    envVar: 'GEMINI_API_KEY',       costPer1kTokens: 0.000075 },
]

export interface AvailableProvider {
  id: string
  family: Family
  model: string
  enabled: boolean
  hasKey: boolean
  priority: number
}

/** List providers we know about + whether the operator has them configured. */
export async function listAvailableProviders(workspaceId: string): Promise<AvailableProvider[]> {
  const configs = await db.select().from(providerConfigs)
    .where(eq(providerConfigs.workspaceId, workspaceId))
    .catch(() => [])
  const configMap = new Map(configs.map(c => [c.providerId, c]))
  return KNOWN_PROVIDERS.map(p => {
    const cfg = configMap.get(p.id)
    return {
      id: p.id, family: p.family,
      model: p.defaultModel,
      enabled: cfg?.enabled ?? false,
      hasKey: Boolean(process.env[p.envVar]),
      priority: cfg?.priority ?? 50,
    }
  })
}

/** Pick the highest-priority enabled provider whose key is configured. */
export async function pickProvider(workspaceId: string, override?: string): Promise<ProviderDef | null> {
  if (override) {
    const def = KNOWN_PROVIDERS.find(p => p.id === override)
    if (def && process.env[def.envVar]) return def
  }
  const available = await listAvailableProviders(workspaceId)
  const enabled = available
    .filter(p => p.enabled && p.hasKey)
    .sort((a, b) => a.priority - b.priority)
  if (enabled.length === 0) {
    // Fallback: any provider with a key (so we don't fail on cold workspace)
    const anyKey = KNOWN_PROVIDERS.find(p => process.env[p.envVar])
    return anyKey ?? null
  }
  const first = enabled[0]!
  return KNOWN_PROVIDERS.find(p => p.id === first.id) ?? null
}

// ─── Streaming handlers per family ──────────────────────────────────────

async function* streamOpenAI(p: ProviderDef, msgs: ChatMsg[], abort?: AbortSignal): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const result = await fetchWithRetry(p.id, `${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: p.defaultModel,
      messages: msgs.map(m => (m.role === 'user' && m.attachments?.length)
        ? { role: m.role, content: materializeOpenAI(m.content, m.attachments) }
        : { role: m.role, content: m.content }),
      stream: true, temperature: 0.3, max_tokens: 2000,
      // Ask OpenAI-compatible providers to emit usage on the final chunk.
      // Without this, prompt_tokens / cached_tokens never arrive in the
      // stream and we lose visibility into server-side prompt caching
      // (auto-enabled on OpenAI for prompts ≥1024 tokens; cached input
      // billed at 50% of base rate, so accounting must reflect it).
      stream_options: { include_usage: true },
    }),
    signal: abort
      ? AbortSignal.any([abort, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000),
  })
  if (!result.ok || !result.response.body) {
    const status = result.ok ? 0 : result.status
    const note = !result.ok && result.circuitOpen ? ' circuit-open' : !result.ok ? ` after ${result.attempts} attempts` : ''
    yield { delta: `_(${p.id} error: ${status}${note})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const res = result.response
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', tokens = 0
  let promptTok = 0, completionTok = 0, cachedTok = 0
  try {
    while (true) {
      if (abort?.aborted) { await reader.cancel().catch(() => null); break }
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
            usage?: {
              total_tokens?: number
              prompt_tokens?: number
              completion_tokens?: number
              prompt_tokens_details?: { cached_tokens?: number }
            }
            x_groq?: { usage?: { total_tokens?: number } }
          }
          const d = obj.choices?.[0]?.delta?.content ?? ''
          if (d) { full += d; yield { delta: d, done: false } }
          const u = obj.usage?.total_tokens ?? obj.x_groq?.usage?.total_tokens
          if (u) tokens = u
          if (obj.usage?.prompt_tokens     != null) promptTok     = obj.usage.prompt_tokens
          if (obj.usage?.completion_tokens != null) completionTok = obj.usage.completion_tokens
          if (obj.usage?.prompt_tokens_details?.cached_tokens != null) {
            cachedTok = obj.usage.prompt_tokens_details.cached_tokens
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    // Defensive: if the loop exits abnormally, release the reader so the
    // underlying connection is freed instead of held until socket timeout.
    reader.releaseLock()
  }
  yield { delta: '', done: true }
  // OpenAI caches input prompts ≥1024 tokens automatically (no
  // cache_control header needed). Cached tokens are billed at 50% of the
  // base input rate; account for the savings so the dashboard reflects
  // real spend, not nominal token count.
  const baseRate = p.costPer1kTokens ?? 0
  const nonCachedInput = Math.max(0, promptTok - cachedTok)
  const inputCost  = ((nonCachedInput / 1000) * baseRate)
                   + ((cachedTok      / 1000) * baseRate * 0.5)
  const outputCost = (completionTok   / 1000) * baseRate
  const effectiveCost = (promptTok > 0 || completionTok > 0)
    ? Number((inputCost + outputCost).toFixed(6))
    : Number(((tokens / 1000) * baseRate).toFixed(6))
  const out: StreamResult = {
    content: full, tokens,
    costUsd: effectiveCost,
    provider: p.id, model: p.defaultModel,
  }
  if (cachedTok > 0) out.cacheReadTokens = cachedTok
  return out
}

async function* streamAnthropic(p: ProviderDef, msgs: ChatMsg[], abort?: AbortSignal, opts?: StreamOpts): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  // Anthropic separates system from messages
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const userMsgs = msgs.filter(m => m.role !== 'system')

  // Prompt caching — mark the system block as `ephemeral` so Anthropic
  // reuses it across calls (5-min TTL). The system prompt contains the
  // injected playbook (~95k words across YouTube / social / POD / runbook),
  // which is identical turn-to-turn — cache hits cut input token cost by
  // 90% and slash time-to-first-token. Only worth caching if the block is
  // ≥1024 tokens (~4KB); below that, Anthropic ignores cache_control.
  // We send as an array so we can attach the cache_control marker.
  const cacheableSystem = system.length >= 4_000
    ? [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
    : system

  // Extended thinking — opt-in via opts.think=true. When enabled, the
  // model produces a separate `thinking` content block that we surface
  // via StreamChunk.thinking so the UI can render it in its own panel.
  // Requires temperature=1 and currently only models claude-3-7+ have
  // native support; older models silently ignore the param.
  const wantsThinking = opts?.think === true
  const thinkingBlock = wantsThinking
    ? { type: 'enabled' as const, budget_tokens: Math.max(1024, Math.min(opts?.thinkingBudget ?? 4_096, 16_384)) }
    : undefined

  const result = await fetchWithRetry(p.id, `${p.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Prompt-caching graduated to GA but the beta header remains a
      // safe no-op on current API and unlocks the feature on older
      // accounts that haven't been auto-migrated.
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: p.defaultModel, max_tokens: 2000, stream: true,
      // Extended thinking requires temperature=1; otherwise honour the
      // default of 0.3 for deterministic-ish chat behaviour.
      temperature: wantsThinking ? 1 : 0.3,
      system: cacheableSystem,
      ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
      messages: userMsgs.map(m => (m.role === 'user' && m.attachments?.length)
        ? { role: m.role, content: materializeAnthropic(m.content, m.attachments) }
        : { role: m.role, content: m.content }),
    }),
    signal: abort
      ? AbortSignal.any([abort, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000),
  })
  if (!result.ok || !result.response.body) {
    const status = result.ok ? 0 : result.status
    const note = !result.ok && result.circuitOpen ? ' circuit-open' : !result.ok ? ` after ${result.attempts} attempts` : ''
    yield { delta: `_(${p.id} error: ${status}${note})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const res = result.response
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', thinkBuf = '', inTok = 0, outTok = 0
  let cacheRead = 0, cacheCreate = 0
  try {
    while (true) {
      if (abort?.aborted) { await reader.cancel().catch(() => null); break }
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        try {
          const obj = JSON.parse(payload) as {
            type?: string
            delta?: { text?: string; type?: string; thinking?: string }
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
          }
          if (obj.type === 'content_block_delta') {
            // Two delta variants: text (final answer) and thinking
            // (extended-thinking scratch). Surface separately so the UI
            // can render the thinking trace in its own panel.
            if (obj.delta?.type === 'thinking_delta' && obj.delta.thinking) {
              thinkBuf += obj.delta.thinking
              yield { delta: '', thinking: obj.delta.thinking, done: false }
            } else if (obj.delta?.text) {
              full += obj.delta.text
              yield { delta: obj.delta.text, done: false }
            }
          }
          // Cache accounting lives on the message-start event (and is
          // sometimes echoed on message_delta). Capture both.
          const usage = obj.message?.usage ?? obj.usage
          if (usage) {
            if (typeof usage.input_tokens === 'number')                inTok        = usage.input_tokens
            if (typeof usage.output_tokens === 'number')               outTok       = usage.output_tokens
            if (typeof usage.cache_read_input_tokens === 'number')     cacheRead    = usage.cache_read_input_tokens
            if (typeof usage.cache_creation_input_tokens === 'number') cacheCreate  = usage.cache_creation_input_tokens
          }
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
  yield { delta: '', done: true }
  const tokens = inTok + outTok
  // Anthropic prompt-caching cost model: cache_read at 10% of input rate,
  // cache_creation at 125%. Approximate effective cost so the dashboard
  // reflects real spend rather than nominal token count.
  const baseRate = p.costPer1kTokens ?? 0
  const inputCost  = ((inTok       / 1000) * baseRate)
                   + ((cacheRead   / 1000) * baseRate * 0.1)
                   + ((cacheCreate / 1000) * baseRate * 1.25)
  const outputCost = (outTok / 1000) * baseRate
  const out: StreamResult = {
    content: full, tokens,
    costUsd: Number((inputCost + outputCost).toFixed(6)),
    provider: p.id, model: p.defaultModel,
  }
  if (cacheRead    > 0) out.cacheReadTokens     = cacheRead
  if (cacheCreate  > 0) out.cacheCreationTokens = cacheCreate
  if (thinkBuf.length > 0) out.thinkingTokens   = Math.ceil(thinkBuf.length / 4)
  return out
}

async function* streamGemini(p: ProviderDef, msgs: ChatMsg[], abort?: AbortSignal): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  // Gemini format: system separately, alternating user/model contents
  const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const contents = msgs.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: (m.role === 'user' && m.attachments?.length)
      ? materializeGemini(m.content, m.attachments)
      : [{ text: m.content }],
  }))

  const url = `${p.baseUrl}/models/${p.defaultModel}:streamGenerateContent?alt=sse&key=${apiKey}`
  const result = await fetchWithRetry(p.id, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
    }),
    signal: abort
      ? AbortSignal.any([abort, AbortSignal.timeout(90_000)])
      : AbortSignal.timeout(90_000),
  })
  if (!result.ok || !result.response.body) {
    const status = result.ok ? 0 : result.status
    const note = !result.ok && result.circuitOpen ? ' circuit-open' : !result.ok ? ` after ${result.attempts} attempts` : ''
    yield { delta: `_(${p.id} error: ${status}${note})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const res = result.response
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', tokens = 0, cachedTok = 0
  try {
    while (true) {
      if (abort?.aborted) { await reader.cancel().catch(() => null); break }
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        try {
          const obj = JSON.parse(payload) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
            usageMetadata?: { totalTokenCount?: number; cachedContentTokenCount?: number }
          }
          const text = obj.candidates?.[0]?.content?.parts?.[0]?.text
          if (text) { full += text; yield { delta: text, done: false } }
          if (obj.usageMetadata?.totalTokenCount)         tokens    = obj.usageMetadata.totalTokenCount
          if (obj.usageMetadata?.cachedContentTokenCount) cachedTok = obj.usageMetadata.cachedContentTokenCount
        } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
  yield { delta: '', done: true }
  // Gemini implicit context caching reports cached tokens via
  // cachedContentTokenCount on usageMetadata. Cached tokens are billed
  // at 25% of the base input rate; surface the savings honestly.
  const baseRate = p.costPer1kTokens ?? 0
  const nonCached = Math.max(0, tokens - cachedTok)
  const cost = ((nonCached / 1000) * baseRate) + ((cachedTok / 1000) * baseRate * 0.25)
  const out: StreamResult = {
    content: full, tokens,
    costUsd: Number(cost.toFixed(6)),
    provider: p.id, model: p.defaultModel,
  }
  if (cachedTok > 0) out.cacheReadTokens = cachedTok
  return out
}

/** Per-call streaming options. `think` opts the call into Anthropic
 *  extended thinking (model produces a visible reasoning trace before
 *  the final answer); silently no-op on providers that don't support it. */
export interface StreamOpts {
  preferProvider?: string
  signal?:         AbortSignal
  think?:          boolean
  thinkingBudget?: number
}

/** Stream with automatic fallback across configured providers. */
export async function* streamChat(workspaceId: string, msgs: ChatMsg[], opts?: StreamOpts): AsyncGenerator<StreamChunk, StreamResult> {
  // Heartbeat the llm agent — every chat call is real AI activity.
  void import('./agent-state-sync.js').then(m => m.recordAgentActivity(workspaceId, 'llm', { status: 'running' })).catch(() => null)
  const tried: string[] = []
  // R146 — accumulate every provider's error-marker delta across the
  // fallback chain. Without this, when both groq AND gemini fail the
  // operator only saw the LAST provider's error (the per-iteration
  // `bufferedDeltas` resets each loop). Now: each failed attempt pushes
  // its terminal error marker(s) into `failureMarkers`, and the final
  // "fallback exhausted" flush emits them ALL so the diagnostic chain is
  // visible — `_(groq error: 429)_ _(gemini error: 404)_` instead of
  // just `_(gemini error: 404)_`.
  const failureMarkers: StreamChunk[] = []
  let provider = await pickProvider(workspaceId, opts?.preferProvider)

  while (provider && !tried.includes(provider.id)) {
    tried.push(provider.id)
    const stream =
      provider.family === 'anthropic' ? streamAnthropic(provider, msgs, opts?.signal, opts)
      : provider.family === 'gemini'  ? streamGemini(provider, msgs, opts?.signal)
      : streamOpenAI(provider, msgs, opts?.signal)

    let gotAnyContent = false
    // Buffer the deltas for THIS provider attempt so an error-marker
    // delta doesn't leak to the operator before we know whether the
    // fallback provider succeeds. Bounded buffer: once real content
    // arrives + we exceed BUFFER_FLUSH_CHARS, flush immediately and
    // stream the rest live. Without the cap, a 10k-token response from
    // a working provider sat in memory until the whole stream finished;
    // under concurrent load that's a real memory leak.
    const BUFFER_FLUSH_CHARS = 4_000
    const bufferedDeltas: StreamChunk[] = []
    let bufferedChars = 0
    let flushed = false
    let next: IteratorResult<StreamChunk, StreamResult>
    while (!(next = await stream.next()).done) {
      const d = next.value.delta ?? ''
      // Provider-error deltas (shaped "_(<provider> error: ...)_") do
      // NOT count as real content — they should trigger fallback, not
      // burn the operator's eyeballs.
      const isErrorMarker = /^_\([a-z][a-z0-9_-]*\s+(?:error|key\s+not\s+set):/.test(d)
      if (d && !isErrorMarker) gotAnyContent = true
      if (flushed) {
        // Past the early-flush threshold — stream the rest live.
        yield next.value
      } else {
        bufferedDeltas.push(next.value)
        bufferedChars += d.length
        if (gotAnyContent && bufferedChars >= BUFFER_FLUSH_CHARS) {
          // We've decided this provider is producing real content —
          // flush the buffer and free its memory before continuing.
          for (const ev of bufferedDeltas) yield ev
          bufferedDeltas.length = 0
          flushed = true
        }
      }
    }
    const result = next.value
    if (result.content.length > 0) {
      // Real content arrived — flush any remaining buffer + return.
      if (!flushed) for (const ev of bufferedDeltas) yield ev
      return result
    }
    // Provider returned no content (key missing / error). Capture its
    // error marker(s) so we can surface the whole failure chain at the
    // end, then try the next fallback.
    for (const ev of bufferedDeltas) failureMarkers.push(ev)
    if (!gotAnyContent && tried.length < 3) {
      const available = await listAvailableProviders(workspaceId)
      const fallback = available
        .filter(p => p.enabled && p.hasKey && !tried.includes(p.id))
        .sort((a, b) => a.priority - b.priority)[0]
      if (fallback) {
        provider = KNOWN_PROVIDERS.find(p => p.id === fallback.id) ?? null
        continue
      }
      // No untried provider available: fall through to flush the full
      // accumulated marker chain below.
    }
    // Fallback exhausted: emit every provider's error marker + return.
    for (const ev of failureMarkers) yield ev
    return result
  }

  yield {
    delta: '_(No LLM provider configured. Add one at /providers — paste an API key + enable.)_',
    done: true,
  }
  return { content: '_(no provider)_', tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
}

/** Enable/disable + set priority for a provider in this workspace. */
/** Mark setup step lazily — non-blocking, swallows errors. */
async function _markFirstProvider(workspaceId: string): Promise<void> {
  try {
    const { markSetupStep } = await import('./platform-hardening.js')
    await markSetupStep(workspaceId, 'firstProviderAt')
  } catch { /* tolerated */ }
}

export async function configureProvider(workspaceId: string, providerId: string, opts: { enabled?: boolean; priority?: number; label?: string }): Promise<void> {
  if (opts.enabled === true) void _markFirstProvider(workspaceId)
  const def = KNOWN_PROVIDERS.find(p => p.id === providerId)
  if (!def) throw new Error(`unknown provider: ${providerId}`)
  const { v7: uuidv7 } = await import('uuid')
  const now = Date.now()

  // Read current values so partial updates (only `enabled`, say) preserve
  // the other fields. The actual write is an atomic upsert on the
  // (workspace_id, provider_id) unique constraint (migration 0045) —
  // replaces the prior SELECT-then-INSERT/UPDATE where two concurrent
  // calls both INSERTed duplicate rows (onConflictDoNothing was a no-op
  // because no matching constraint existed).
  const existing = await db.select().from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.providerId, providerId)))
    .limit(1).then(r => r[0]).catch(() => null)

  const enabled  = opts.enabled  ?? existing?.enabled  ?? true
  const priority = opts.priority ?? existing?.priority ?? 50
  const label    = opts.label    ?? existing?.label    ?? def.id

  await db.insert(providerConfigs).values({
    id: uuidv7(), workspaceId, providerId,
    label, enabled, priority,
    createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({
    target: [providerConfigs.workspaceId, providerConfigs.providerId],
    set: { label, enabled, priority, updatedAt: now },
  }).catch((e: unknown) => {
    console.error('[chat-providers] configureProvider upsert failed:', (e as Error).message)
  })
}
