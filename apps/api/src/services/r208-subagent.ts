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
  prompt:      string
  schema?:     Record<string, unknown>
  parentOp?:   string
  maxBytes?:   number
}

export interface SubagentResult {
  id:        string
  text:      string
  parsed?:   unknown
  error?:    string
  tokensIn:  number
  tokensOut: number
  costUsd:   number
  ms:        number
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
  let error: string | undefined
  let parsed: unknown
  try {
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user', content: req.prompt },
    ], { taskType: 'chat' })
    while (true) {
      const next = await gen.next()
      if (next.done) {
        const r = next.value
        tokensIn  = r.promptTokens ?? 0
        tokensOut = r.tokens
        costUsd   = r.costUsd
        text      = r.content
        break
      }
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
  return out
}

/** Run N sub-agents in parallel. Failures resolve to result with .error set. */
export async function parallelSubagents(workspaceId: string, requests: SubagentRequest[]): Promise<SubagentResult[]> {
  return Promise.all(requests.map(r => spawnSubagent(workspaceId, r).catch((e: Error) => ({
    id: '', text: '', error: e.message, tokensIn: 0, tokensOut: 0, costUsd: 0, ms: 0,
  } as SubagentResult))))
}
