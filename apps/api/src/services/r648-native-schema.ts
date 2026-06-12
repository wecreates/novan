/**
 * R648 — Provider-native structured-output.
 *
 * Where the provider supports it natively, we get guaranteed-valid JSON
 * with no retries:
 *   - Anthropic → forced tool_choice with the schema as the tool's input_schema
 *   - OpenAI    → response_format: { type: 'json_schema', json_schema: {...} }
 * Otherwise we fall back to the R647b prompt-layer impl.
 *
 * Exposed as a separate brain op (chat.with_schema_native) so the operator
 * can A/B against R647b. Picks provider via OPENAI_API_KEY / ANTHROPIC_API_KEY
 * env presence + an optional preferProvider param.
 */
import { withSchema } from './r647-structured-output.js'

export interface NativeSchemaInput {
  prompt:         string
  schema:         Record<string, unknown>
  systemPrompt?:  string
  preferProvider?: 'anthropic' | 'openai' | 'auto'
  model?:         string
}

export interface NativeSchemaResult {
  ok:        boolean
  data?:     unknown
  error?:    string
  provider:  string
  model:     string
  tokens:    number
  costUsd:   number
  latencyMs: number
}

function pickProvider(pref?: NativeSchemaInput['preferProvider']): 'anthropic' | 'openai' | 'fallback' {
  const wantAnth = pref === 'anthropic' || pref === 'auto' || pref === undefined
  const wantOAI  = pref === 'openai'    || pref === 'auto' || pref === undefined
  if (wantAnth && process.env['ANTHROPIC_API_KEY']) return 'anthropic'
  if (wantOAI  && process.env['OPENAI_API_KEY'])    return 'openai'
  return 'fallback'
}

export async function withSchemaNative(workspaceId: string, input: NativeSchemaInput): Promise<NativeSchemaResult> {
  const t0 = Date.now()
  const choice = pickProvider(input.preferProvider)
  if (choice === 'anthropic') return runAnthropic(workspaceId, input, t0)
  if (choice === 'openai')    return runOpenAI(workspaceId, input, t0)

  // No provider key → reuse R647 prompt-layer fallback
  const fallback = await withSchema(workspaceId, { prompt: input.prompt, schema: input.schema, ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}) })
  const r: NativeSchemaResult = {
    ok: fallback.ok,
    provider: 'fallback-prompt-layer',
    model: 'router-chosen',
    tokens: fallback.tokens, costUsd: fallback.costUsd,
    latencyMs: Date.now() - t0,
  }
  if (fallback.data  !== undefined) r.data  = fallback.data
  if (fallback.error !== undefined) r.error = fallback.error
  return r
}

async function runAnthropic(_workspaceId: string, input: NativeSchemaInput, t0: number): Promise<NativeSchemaResult> {
  const apiKey = process.env['ANTHROPIC_API_KEY']!
  const model = input.model ?? 'claude-sonnet-4-6'
  const body: Record<string, unknown> = {
    model,
    // R672 — was 4096; structured-output responses are bounded by the schema shape
    // and 1024 is plenty for typical {subgoal,reasoning,tools_needed} or
    // {done,answer,next_subgoal} returns.
    max_tokens: 1024,
    system: input.systemPrompt ?? 'You are a precise JSON generator. Always use the structured_output tool.',
    messages: [{ role: 'user', content: input.prompt }],
    tools: [{
      name: 'structured_output',
      description: 'Emit the answer in the required structured form.',
      input_schema: input.schema,
    }],
    tool_choice: { type: 'tool', name: 'structured_output' },
  }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, error: `anthropic ${res.status}: ${await res.text().catch(() => '')}`,
        provider: 'anthropic', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const j = await res.json() as {
      content?: Array<{ type: string; name?: string; input?: unknown }>
      usage?:   { input_tokens?: number; output_tokens?: number }
    }
    const toolUse = (j.content ?? []).find(c => c.type === 'tool_use' && c.name === 'structured_output')
    if (!toolUse || toolUse.input === undefined) {
      return { ok: false, error: 'anthropic returned no tool_use block',
        provider: 'anthropic', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const inp = (j.usage?.input_tokens ?? 0), out = (j.usage?.output_tokens ?? 0)
    const tokens = inp + out
    // Pricing matches chat-providers.ts: sonnet $0.003 in / $0.015 out per 1k
    const costUsd = (inp / 1000) * 0.003 + (out / 1000) * 0.015
    return {
      ok: true, data: toolUse.input,
      provider: 'anthropic', model,
      tokens, costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - t0,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message,
      provider: 'anthropic', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
  }
}

function normalizeForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
  // OpenAI strict mode: every object must have additionalProperties: false AND
  // every property must appear in `required`. Recursively normalize.
  const s: Record<string, unknown> = { ...schema }
  if (s['type'] === 'object' && s['properties'] && typeof s['properties'] === 'object') {
    const props = s['properties'] as Record<string, Record<string, unknown>>
    const normProps: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of Object.entries(props)) normProps[k] = normalizeForOpenAI(v)
    s['properties'] = normProps
    s['required'] = Object.keys(normProps)
    s['additionalProperties'] = false
  }
  if (s['type'] === 'array' && s['items'] && typeof s['items'] === 'object') {
    s['items'] = normalizeForOpenAI(s['items'] as Record<string, unknown>)
  }
  return s
}

async function runOpenAI(_workspaceId: string, input: NativeSchemaInput, t0: number): Promise<NativeSchemaResult> {
  const apiKey = process.env['OPENAI_API_KEY']!
  const model = input.model ?? 'gpt-4o-mini'
  const body: Record<string, unknown> = {
    model,
    // R672 — same 1024 cap as the Anthropic path
    max_tokens: 1024,
    messages: [
      ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
      { role: 'user', content: input.prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        strict: true,
        schema: normalizeForOpenAI(input.schema),
      },
    },
  }
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return { ok: false, error: `openai ${res.status}: ${await res.text().catch(() => '')}`,
        provider: 'openai', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const j = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?:   { prompt_tokens?: number; completion_tokens?: number }
    }
    const txt = j.choices?.[0]?.message?.content ?? ''
    let data: unknown
    try { data = JSON.parse(txt) } catch {
      return { ok: false, error: `openai response not valid JSON: ${txt.slice(0, 200)}`,
        provider: 'openai', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
    }
    const inp = (j.usage?.prompt_tokens ?? 0), out = (j.usage?.completion_tokens ?? 0)
    const tokens = inp + out
    // gpt-4o-mini pricing: $0.150 in / $0.600 out per 1M
    const costUsd = (inp / 1_000_000) * 0.15 + (out / 1_000_000) * 0.60
    return {
      ok: true, data,
      provider: 'openai', model,
      tokens, costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - t0,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message,
      provider: 'openai', model, tokens: 0, costUsd: 0, latencyMs: Date.now() - t0 }
  }
}
