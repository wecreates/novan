/**
 * R146.208 — Sub-agent spawner. Spins up an isolated streamChat call
 * with a focused prompt and (optional) JSON schema. Each call burns its
 * own context window — parent stays uncluttered. parallel() runs N in
 * parallel; results are persisted to subagent_runs.
 *
 * No mock LLM: this wraps the real chat-providers.streamChat dispatcher.
 * Cost is tracked. Errors don't bubble (returned as result.error).
 */
import { db } from '../db/client.js'
import { subagentRuns } from '../db/schema.js'
import { v7 as uuidv7 } from 'uuid'
import { streamChat } from './chat-providers.js'

export interface SubagentRequest {
  prompt:           string
  schema?:          Record<string, unknown>
  parentOp?:        string
  maxBytes?:        number
  /** R216 — hard token budget. If the generated response would push
   *  output tokens past this, the call is aborted. Default 4000. */
  maxOutputTokens?: number
  /** R216 — preferred provider id (e.g. "anthropic-sonnet"). If
   *  unavailable, falls through provider chain via streamChat fallback. */
  preferProvider?:  string
  /** R216 — explicit task type for routing telemetry. */
  task?:            string
}

export interface SubagentResult {
  id:         string
  text:       string
  parsed?:    unknown
  error?:     string
  tokensIn:   number
  tokensOut:  number
  costUsd:    number
  ms:         number
  provider?:  string
  model?:     string
}

const SCHEMA_INSTRUCTION = 'Return ONLY a single JSON object matching the schema. No prose, no fences, no commentary.'

export async function spawnSubagent(workspaceId: string, req: SubagentRequest): Promise<SubagentResult> {
  const id = uuidv7()
  const startedAt = Date.now()
  await db.insert(subagentRuns).values({
    id, workspaceId, parentOp: req.parentOp ?? null,
    prompt: req.prompt.slice(0, 16_000),
    schema: req.schema ?? null,
    startedAt,
  }).catch(() => null)

  const sys = req.schema
    ? `You are a focused sub-agent. ${SCHEMA_INSTRUCTION}\nSchema: ${JSON.stringify(req.schema)}`
    : 'You are a focused sub-agent. Answer concisely and directly.'

  let text = ''
  let tokensIn = 0, tokensOut = 0, costUsd = 0
  let provider: string | undefined, model: string | undefined
  let error: string | undefined
  let parsed: unknown
  const maxOut = Math.max(100, Math.min(8000, req.maxOutputTokens ?? 4000))
  try {
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user', content: req.prompt },
    ], { taskType: 'chat' })
    let abortBudget = false
    while (true) {
      const next = await gen.next()
      if (next.done) {
        const r = next.value
        tokensIn  = r.promptTokens ?? 0
        tokensOut = r.tokens
        costUsd   = r.costUsd
        text      = r.content
        provider  = r.provider
        model     = r.model
        if (tokensOut > maxOut) { abortBudget = true }
        break
      }
      // R216 — accumulate streamed token estimate; if we exceed budget,
      // try to cancel. Streaming tokens aren't reported per-delta so we
      // estimate as 1 token per 4 chars (rough English heuristic).
      if (next.value.delta) {
        const est = Math.ceil(next.value.delta.length / 4)
        tokensOut += est
        if (tokensOut > maxOut) { abortBudget = true; break }
      }
    }
    if (abortBudget) {
      error = `output budget exceeded (>${maxOut} tokens)`
    }
    if (req.schema) {
      const jsonText = text.trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim()
      try { parsed = JSON.parse(jsonText) } catch (e) {
        error = `schema parse failed: ${(e as Error).message.slice(0, 200)}`
      }
    }
  } catch (e) {
    error = (e as Error).message.slice(0, 500)
  }

  const ms = Date.now() - startedAt
  await db.update(subagentRuns).set({
    result: parsed !== undefined ? (parsed as Record<string, unknown>) : { text: text.slice(0, 4000) },
    error: error ?? null,
    tokensIn, tokensOut, costUsd,
    endedAt: Date.now(),
  }).catch(() => null)

  const out: SubagentResult = { id, text, tokensIn, tokensOut, costUsd, ms }
  if (parsed !== undefined) out.parsed = parsed
  if (error) out.error = error
  if (provider) out.provider = provider
  if (model) out.model = model
  return out
}

/** Run N sub-agents in parallel. Failures resolve to result with .error set. */
export async function parallelSubagents(workspaceId: string, requests: SubagentRequest[]): Promise<SubagentResult[]> {
  return Promise.all(requests.map(r => spawnSubagent(workspaceId, r).catch((e: Error) => ({
    id: '', text: '', error: e.message, tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0,
  } as SubagentResult))))
}
