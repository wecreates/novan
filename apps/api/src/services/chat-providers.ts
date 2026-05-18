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

export type ChatRole = 'system' | 'user' | 'assistant'
export interface ChatMsg { role: ChatRole; content: string }
export interface StreamChunk { delta: string; done: boolean }
export interface StreamResult { content: string; tokens: number; costUsd: number; provider: string; model: string }

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
  { id: 'anthropic',    family: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',                   defaultModel: 'claude-3-5-sonnet-latest', envVar: 'ANTHROPIC_API_KEY',   costPer1kTokens: 0.003 },
  { id: 'gemini',       family: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.0-flash',    envVar: 'GEMINI_API_KEY',       costPer1kTokens: 0.000075 },
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

async function* streamOpenAI(p: ProviderDef, msgs: ChatMsg[]): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: p.defaultModel, messages: msgs, stream: true, temperature: 0.3, max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => { return { ok: false, status: 0, statusText: (e as Error).message } as unknown as Response })
  if (!res || !('body' in res) || !res.ok || !res.body) {
    const status = (res as { status?: number; statusText?: string }).status ?? 0
    yield { delta: `_(${p.id} error: ${status})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', tokens = 0
  while (true) {
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
        const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }>; usage?: { total_tokens?: number }; x_groq?: { usage?: { total_tokens?: number } } }
        const d = obj.choices?.[0]?.delta?.content ?? ''
        if (d) { full += d; yield { delta: d, done: false } }
        const u = obj.usage?.total_tokens ?? obj.x_groq?.usage?.total_tokens
        if (u) tokens = u
      } catch { /* ignore */ }
    }
  }
  yield { delta: '', done: true }
  return {
    content: full, tokens,
    costUsd: Number(((tokens / 1000) * (p.costPer1kTokens ?? 0)).toFixed(6)),
    provider: p.id, model: p.defaultModel,
  }
}

async function* streamAnthropic(p: ProviderDef, msgs: ChatMsg[]): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  // Anthropic separates system from messages
  const system = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const userMsgs = msgs.filter(m => m.role !== 'system')

  const res = await fetch(`${p.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: p.defaultModel, max_tokens: 2000, stream: true, temperature: 0.3,
      system, messages: userMsgs,
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => { return { ok: false, status: 0, statusText: (e as Error).message } as unknown as Response })
  if (!res || !('body' in res) || !res.ok || !res.body) {
    const status = (res as { status?: number }).status ?? 0
    yield { delta: `_(${p.id} error: ${status})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', inTok = 0, outTok = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      try {
        const obj = JSON.parse(payload) as { type?: string; delta?: { text?: string; type?: string }; usage?: { input_tokens?: number; output_tokens?: number }; message?: { usage?: { input_tokens?: number; output_tokens?: number } } }
        if (obj.type === 'content_block_delta' && obj.delta?.text) {
          full += obj.delta.text; yield { delta: obj.delta.text, done: false }
        }
        if (obj.message?.usage) {
          inTok = obj.message.usage.input_tokens ?? 0
          outTok = obj.message.usage.output_tokens ?? 0
        }
        if (obj.usage) {
          inTok += obj.usage.input_tokens ?? 0
          outTok += obj.usage.output_tokens ?? 0
        }
      } catch { /* ignore */ }
    }
  }
  yield { delta: '', done: true }
  const tokens = inTok + outTok
  return {
    content: full, tokens,
    costUsd: Number(((tokens / 1000) * (p.costPer1kTokens ?? 0)).toFixed(6)),
    provider: p.id, model: p.defaultModel,
  }
}

async function* streamGemini(p: ProviderDef, msgs: ChatMsg[]): AsyncGenerator<StreamChunk, StreamResult> {
  const apiKey = process.env[p.envVar]
  if (!apiKey) {
    yield { delta: `_(${p.id} key not set: ${p.envVar})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  // Gemini format: system separately, alternating user/model contents
  const sys = msgs.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const contents = msgs.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const url = `${p.baseUrl}/models/${p.defaultModel}:streamGenerateContent?alt=sse&key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: sys ? { parts: [{ text: sys }] } : undefined,
      contents,
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
    }),
    signal: AbortSignal.timeout(90_000),
  }).catch((e) => { return { ok: false, status: 0, statusText: (e as Error).message } as unknown as Response })
  if (!res || !('body' in res) || !res.ok || !res.body) {
    const status = (res as { status?: number }).status ?? 0
    yield { delta: `_(${p.id} error: ${status})_`, done: true }
    return { content: '', tokens: 0, costUsd: 0, provider: p.id, model: p.defaultModel }
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = '', full = '', tokens = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n'); buf = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const payload = t.slice(5).trim()
      try {
        const obj = JSON.parse(payload) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { totalTokenCount?: number } }
        const text = obj.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) { full += text; yield { delta: text, done: false } }
        if (obj.usageMetadata?.totalTokenCount) tokens = obj.usageMetadata.totalTokenCount
      } catch { /* ignore */ }
    }
  }
  yield { delta: '', done: true }
  return {
    content: full, tokens,
    costUsd: Number(((tokens / 1000) * (p.costPer1kTokens ?? 0)).toFixed(6)),
    provider: p.id, model: p.defaultModel,
  }
}

/** Stream with automatic fallback across configured providers. */
export async function* streamChat(workspaceId: string, msgs: ChatMsg[], opts?: { preferProvider?: string }): AsyncGenerator<StreamChunk, StreamResult> {
  const tried: string[] = []
  let provider = await pickProvider(workspaceId, opts?.preferProvider)

  while (provider && !tried.includes(provider.id)) {
    tried.push(provider.id)
    const stream =
      provider.family === 'anthropic' ? streamAnthropic(provider, msgs)
      : provider.family === 'gemini'  ? streamGemini(provider, msgs)
      : streamOpenAI(provider, msgs)

    let gotAnyContent = false
    let next: IteratorResult<StreamChunk, StreamResult>
    while (!(next = await stream.next()).done) {
      if (next.value.delta) gotAnyContent = true
      yield next.value
    }
    const result = next.value
    if (result.content.length > 0) return result
    // Provider returned no content (key missing / error). Try next.
    if (!gotAnyContent && tried.length < 3) {
      const available = await listAvailableProviders(workspaceId)
      const fallback = available
        .filter(p => p.enabled && p.hasKey && !tried.includes(p.id))
        .sort((a, b) => a.priority - b.priority)[0]
      provider = fallback ? (KNOWN_PROVIDERS.find(p => p.id === fallback.id) ?? null) : null
      continue
    }
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
  const existing = await db.select().from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.providerId, providerId)))
    .limit(1).then(r => r[0]).catch(() => null)
  const now = Date.now()
  if (existing) {
    await db.update(providerConfigs).set({
      enabled: opts.enabled ?? existing.enabled,
      priority: opts.priority ?? existing.priority,
      label: opts.label ?? existing.label,
      updatedAt: now,
    }).where(eq(providerConfigs.id, existing.id)).catch(() => null)
  } else {
    const def = KNOWN_PROVIDERS.find(p => p.id === providerId)
    if (!def) throw new Error(`unknown provider: ${providerId}`)
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(providerConfigs).values({
      id: uuidv7(), workspaceId, providerId,
      label: opts.label ?? def.id,
      enabled: opts.enabled ?? true,
      priority: opts.priority ?? 50,
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing().catch(() => null)
  }
}
