/**
 * R647b — Universal structured-output (`responseSchema`) mode.
 *
 * Any chat-style brain op can route through here to force a JSON response that
 * matches a caller-provided JSON Schema. Implementation:
 *   1. Inject a strict system suffix telling the model to emit ONLY JSON
 *      matching the schema (schema is rendered into the prompt).
 *   2. Parse + validate with a tiny ajv-like checker; if invalid, retry once
 *      with the validation error attached.
 *
 * This works across all our providers (Anthropic, OpenAI, Gemini, Cerebras,
 * HuggingFace) because we drive it at the prompt layer, not the provider API.
 * Provider-native structured-output (Anthropic tool_choice, OpenAI json_schema)
 * is a later refinement.
 */
import type { ChatMsg } from './chat-providers.js'

export interface SchemaInput {
  prompt:         string
  schema:         Record<string, unknown>  // JSON Schema (draft-07 subset)
  systemPrompt?:  string
  preferProvider?: string
  maxRetries?:    number
}

export interface SchemaResult {
  ok:        boolean
  data?:     unknown
  error?:    string
  attempts:  number
  tokens:    number
  costUsd:   number
  latencyMs: number
}

function extractJson(text: string): unknown | null {
  const t = text.trim()
  // Try as-is
  try { return JSON.parse(t) } catch { /* fall through */ }
  // Try fenced ```json ... ```
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()) } catch { /* fall through */ } }
  // Try first balanced { ... } or [ ... ]
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    const start = t.indexOf(open)
    if (start < 0) continue
    let depth = 0
    for (let i = start; i < t.length; i++) {
      if (t[i] === open) depth++
      else if (t[i] === close) { depth--; if (depth === 0) {
        try { return JSON.parse(t.slice(start, i + 1)) } catch { break }
      } }
    }
  }
  return null
}

interface ValidationError { path: string; message: string }

function validate(data: unknown, schema: Record<string, unknown>, path = '$'): ValidationError[] {
  const errs: ValidationError[] = []
  const type = schema['type']
  const required = schema['required'] as string[] | undefined
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined
  const items = schema['items'] as Record<string, unknown> | undefined
  const enumVals = schema['enum'] as unknown[] | undefined

  const actualType =
    data === null ? 'null' :
    Array.isArray(data) ? 'array' :
    typeof data

  if (type) {
    const expected = Array.isArray(type) ? type : [type]
    if (!expected.includes(actualType) && !(expected.includes('integer') && actualType === 'number' && Number.isInteger(data))) {
      errs.push({ path, message: `expected ${expected.join('|')} but got ${actualType}` })
      return errs
    }
  }
  if (enumVals && !enumVals.includes(data as never)) {
    errs.push({ path, message: `value not in enum [${enumVals.map(v => JSON.stringify(v)).join(', ')}]` })
  }
  if (actualType === 'object' && properties) {
    const obj = data as Record<string, unknown>
    if (required) for (const k of required) {
      if (!(k in obj)) errs.push({ path: `${path}.${k}`, message: 'required property missing' })
    }
    for (const [k, subSchema] of Object.entries(properties)) {
      if (k in obj) errs.push(...validate(obj[k], subSchema, `${path}.${k}`))
    }
  }
  if (actualType === 'array' && items) {
    for (let i = 0; i < (data as unknown[]).length; i++) {
      errs.push(...validate((data as unknown[])[i], items, `${path}[${i}]`))
    }
  }
  return errs
}

function schemaPromptSuffix(schema: Record<string, unknown>): string {
  return `\n\nRespond with ONLY a JSON value matching this JSON Schema. No prose, no markdown fences, no commentary — JSON only.\n\nSchema:\n${JSON.stringify(schema, null, 2)}`
}

export async function withSchema(workspaceId: string, input: SchemaInput): Promise<SchemaResult> {
  const t0 = Date.now()
  const { streamChat } = await import('./chat-providers.js')
  const maxRetries = Math.max(0, Math.min(3, input.maxRetries ?? 1))
  let totalTokens = 0, totalCost = 0
  let lastErr = 'no attempt'

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const msgs: ChatMsg[] = [
      { role: 'system', content: (input.systemPrompt ?? 'You are a precise JSON generator.') + schemaPromptSuffix(input.schema) },
      { role: 'user',   content: attempt === 1 ? input.prompt : `${input.prompt}\n\nPrevious attempt failed validation:\n${lastErr}\nFix and retry.` },
    ]
    let raw = ''
    let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
    const opts: Parameters<typeof streamChat>[2] = { skipUsageTracking: false }
    if (input.preferProvider) opts.preferProvider = input.preferProvider
    const stream = streamChat(workspaceId, msgs, opts)
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
    final = next.value
    totalTokens += final.tokens
    totalCost   += final.costUsd

    const data = extractJson(raw)
    if (data == null) { lastErr = `output was not valid JSON: ${raw.slice(0, 200)}`; continue }
    const errs = validate(data, input.schema)
    if (errs.length === 0) {
      return { ok: true, data, attempts: attempt, tokens: totalTokens, costUsd: Number(totalCost.toFixed(6)), latencyMs: Date.now() - t0 }
    }
    lastErr = errs.map(e => `${e.path}: ${e.message}`).join('; ')
  }

  return {
    ok: false, error: lastErr,
    attempts: maxRetries + 1,
    tokens: totalTokens, costUsd: Number(totalCost.toFixed(6)),
    latencyMs: Date.now() - t0,
  }
}
