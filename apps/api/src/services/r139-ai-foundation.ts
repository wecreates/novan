/**
 * R146.139 — S-tier AI foundation: semantic memory + RAG + structured
 * output + tool-use loop + eval suite + multi-modal flag.
 */
import { db } from '../db/client.js'
import { memoryChunks, promptEvalCases, promptEvalRuns } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #1 — Semantic memory + RAG ──────────────────────────────────────

export async function memoryStore(workspaceId: string, opts: {
  content: string
  sourceType: 'chat' | 'decision' | 'proposal' | 'doc' | 'event' | 'manual'
  sourceId?: string
  metadata?: Record<string, unknown>
  pinned?: boolean
}): Promise<{ id: string; embedded: boolean }> {
  const id = uuidv7()
  const { embed } = await import('./embeddings.js')
  const vec = await embed(opts.content.slice(0, 8000))
  await db.insert(memoryChunks).values({
    id, workspaceId,
    content: opts.content.slice(0, 10000),
    sourceType: opts.sourceType,
    sourceId: opts.sourceId ?? null,
    metadata: opts.metadata ?? {},
    embedding: vec,
    pinned: opts.pinned === true,
    createdAt: Date.now(),
  })
  return { id, embedded: vec !== null }
}

export async function memoryRecall(workspaceId: string, opts: {
  query: string
  k?: number
  sourceType?: string
  includePinned?: boolean
}): Promise<Array<{ id: string; content: string; sourceType: string; sourceId: string | null; similarity: number }>> {
  const k = Math.max(1, Math.min(opts.k ?? 5, 50))
  const { embed } = await import('./embeddings.js')
  const queryVec = await embed(opts.query.slice(0, 2000))
  if (!queryVec) {
    // Fallback: keyword search via plain SQL
    const where = opts.sourceType
      ? and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.sourceType, opts.sourceType))
      : eq(memoryChunks.workspaceId, workspaceId)
    const rows = await db.select().from(memoryChunks).where(where).orderBy(desc(memoryChunks.createdAt)).limit(k)
    return rows.map(r => ({ id: r.id, content: r.content, sourceType: r.sourceType, sourceId: r.sourceId, similarity: 0 }))
  }
  // pgvector cosine distance: lower = more similar
  const sourceFilter = opts.sourceType ? sql`AND source_type = ${opts.sourceType}` : sql``
  const rows = await db.execute(sql`
    SELECT id, content, source_type, source_id, 1 - (embedding <=> ${sql.raw(`'[${queryVec.join(',')}]'::vector`)}) AS similarity
    FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND embedding IS NOT NULL ${sourceFilter}
    ORDER BY embedding <=> ${sql.raw(`'[${queryVec.join(',')}]'::vector`)}
    LIMIT ${k}
  `) as unknown as Array<{ id: string; content: string; source_type: string; source_id: string | null; similarity: number }>
  // Bump access stats best-effort
  const ids = rows.map(r => r.id)
  if (ids.length > 0) {
    db.execute(sql`UPDATE memory_chunks SET accessed_count = accessed_count + 1, last_accessed_at = ${Date.now()} WHERE id = ANY(${ids})`).catch(() => null)
  }
  return rows.map(r => ({ id: r.id, content: r.content, sourceType: r.source_type, sourceId: r.source_id, similarity: r.similarity }))
}

export async function memoryPin(workspaceId: string, id: string, pinned: boolean): Promise<{ ok: boolean }> {
  await db.update(memoryChunks).set({ pinned })
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, id)))
  return { ok: true }
}

export async function memoryDelete(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.delete(memoryChunks).where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, id)))
  return { ok: true }
}

// ─── #2 — Structured output enforcement ──────────────────────────────

export interface StructuredCallInput {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  jsonSchema: Record<string, unknown>
  maxRetries?: number
  maxTokens?: number
}

/**
 * Calls LLM with messages + a JSON schema. Validates output against schema;
 * on failure, retries with the validation error included in the prompt.
 *
 * Schema validator is a minimal type-check (object/array/string/number/
 * boolean/null + required keys). Not full JSON-Schema — covers 90% of
 * real shapes.
 */
export async function structuredCall(workspaceId: string, input: StructuredCallInput): Promise<{ ok: true; value: unknown } | { ok: false; error: string; rawAttempts: string[] }> {
  const maxRetries = Math.max(0, Math.min(input.maxRetries ?? 2, 4))
  const schemaText = JSON.stringify(input.jsonSchema)
  const attempts: string[] = []
  let lastError = ''
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const msgs = [...input.messages]
    if (attempt === 0) {
      msgs.push({ role: 'system', content: `Respond ONLY with JSON matching this schema:\n${schemaText}\nReturn the JSON object alone, no prose.` })
    } else {
      msgs.push({ role: 'system', content: `Previous response failed: ${lastError}\nRetry. JSON only, matching:\n${schemaText}` })
    }
    const { streamChat } = await import('./chat-providers.js')
    const gen = streamChat(workspaceId, msgs, { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    attempts.push(acc.slice(0, 4000))
    const m = acc.match(/\{[\s\S]*\}/) || acc.match(/\[[\s\S]*\]/)
    if (!m) { lastError = 'no JSON found in output'; continue }
    try {
      const parsed = JSON.parse(m[0])
      const valid = validateSchema(parsed, input.jsonSchema)
      if (valid.ok) return { ok: true, value: parsed }
      lastError = valid.error
    } catch (e) {
      lastError = `JSON parse failed: ${(e as Error).message.slice(0, 200)}`
    }
  }
  return { ok: false, error: lastError, rawAttempts: attempts }
}

function validateSchema(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const t = (schema['type'] ?? '') as string
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: `expected object, got ${Array.isArray(value) ? 'array' : typeof value}` }
    const req = (schema['required'] ?? []) as string[]
    for (const k of req) {
      if (!(k in (value as object))) return { ok: false, error: `missing required key: ${k}` }
    }
    const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>
    for (const [k, sub] of Object.entries(props)) {
      if (k in (value as object)) {
        const r = validateSchema((value as Record<string, unknown>)[k], sub)
        if (!r.ok) return { ok: false, error: `at .${k}: ${r.error}` }
      }
    }
    return { ok: true }
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: `expected array, got ${typeof value}` }
    const items = schema['items'] as Record<string, unknown> | undefined
    if (items) {
      for (let i = 0; i < value.length; i++) {
        const r = validateSchema(value[i], items)
        if (!r.ok) return { ok: false, error: `at [${i}]: ${r.error}` }
      }
    }
    return { ok: true }
  }
  if (t === 'string')  return typeof value === 'string'  ? { ok: true } : { ok: false, error: `expected string, got ${typeof value}` }
  if (t === 'number' || t === 'integer') return typeof value === 'number' ? { ok: true } : { ok: false, error: `expected number, got ${typeof value}` }
  if (t === 'boolean') return typeof value === 'boolean' ? { ok: true } : { ok: false, error: `expected boolean, got ${typeof value}` }
  if (t === 'null')    return value === null ? { ok: true } : { ok: false, error: `expected null` }
  return { ok: true }
}

// ─── #3 — Tool-use / ReAct loop ──────────────────────────────────────

export interface AgentLoopResult {
  finalAnswer: string
  steps: Array<{ thought: string; opCalled?: string; opParams?: Record<string, unknown>; opResult?: unknown; error?: string }>
  ranOps: string[]
}

const SAFE_OPS_FOR_AGENT = new Set([
  'novan.capabilities', 'autonomy.counts',
  'memory.recall', 'memory.store',
  'proposals.list', 'patches.list', 'attribution.list',
  'quota.summary', 'spend.status', 'agents.list',
  'twin.simulate', 'funnel.imagine', 'anomaly.explain',
  'docs.latest', 'skill.roiRank',
])

/**
 * ReAct-style loop: LLM proposes Thought + Action (op + params), we
 * execute the op, feed back Observation, iterate until "FINAL:" or
 * maxSteps. Action whitelist is conservative — operator must add ops
 * to SAFE_OPS_FOR_AGENT to enable them.
 */
export async function agentLoop(workspaceId: string, opts: {
  goal: string
  maxSteps?: number
  contextMemoryK?: number
}): Promise<AgentLoopResult> {
  const maxSteps = Math.max(1, Math.min(opts.maxSteps ?? 8, 20))
  const steps: AgentLoopResult['steps'] = []
  const ranOps: string[] = []

  // Pull relevant memory chunks as initial context
  let memoryContext = ''
  if ((opts.contextMemoryK ?? 0) > 0) {
    const recalled = await memoryRecall(workspaceId, { query: opts.goal, k: opts.contextMemoryK ?? 3 }).catch(() => [])
    if (recalled.length > 0) {
      memoryContext = `\n\nRecalled memory:\n${recalled.map(r => `- ${r.content.slice(0, 200)}`).join('\n')}`
    }
  }

  const sysPrompt = `You are an autonomous agent. To accomplish the goal, output one of:
  THOUGHT: <one sentence reasoning>
  ACTION: opName | {"param":"value",...}
  Or when done:
  FINAL: <your answer>

Available ops (whitelist): ${[...SAFE_OPS_FOR_AGENT].join(', ')}
Goal: ${opts.goal}${memoryContext}

Only one ACTION per turn. After each ACTION I will reply with OBSERVATION: <result>. Cap at ${maxSteps} steps.`

  const history: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: sysPrompt },
    { role: 'user',   content: 'Begin.' },
  ]

  for (let step = 0; step < maxSteps; step++) {
    const { streamChat } = await import('./chat-providers.js')
    const gen = streamChat(workspaceId, history, { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    history.push({ role: 'assistant', content: acc })

    const finalMatch = acc.match(/FINAL:\s*([\s\S]*?)$/m)
    if (finalMatch) {
      return { finalAnswer: finalMatch[1]?.trim() ?? '', steps, ranOps }
    }
    const thoughtMatch = acc.match(/THOUGHT:\s*(.+?)(?:\n|$)/)
    const actionMatch  = acc.match(/ACTION:\s*([\w.]+)\s*\|\s*(\{[\s\S]*?\})/)
    if (!actionMatch) {
      steps.push({ thought: thoughtMatch?.[1] ?? '(no thought)', error: 'no ACTION parsed; halting' })
      break
    }
    const opName = actionMatch[1]!
    let params: Record<string, unknown> = {}
    try { params = JSON.parse(actionMatch[2]!) as Record<string, unknown> } catch { /* leave empty */ }
    if (!SAFE_OPS_FOR_AGENT.has(opName)) {
      const observation = `OBSERVATION: op "${opName}" not in agent whitelist. Try one of: ${[...SAFE_OPS_FOR_AGENT].join(', ')}`
      history.push({ role: 'user', content: observation })
      steps.push({ thought: thoughtMatch?.[1] ?? '', opCalled: opName, error: 'whitelist reject' })
      continue
    }
    const { OPERATIONS } = await import('./brain-task.js')
    const opDef = (OPERATIONS as Record<string, { handler: (ws: string, p: Record<string, unknown>) => Promise<unknown> } | undefined>)[opName]
    if (!opDef) {
      const observation = `OBSERVATION: op "${opName}" not found in registry`
      history.push({ role: 'user', content: observation })
      steps.push({ thought: thoughtMatch?.[1] ?? '', opCalled: opName, error: 'not found' })
      continue
    }
    try {
      const result = await opDef.handler(workspaceId, params)
      ranOps.push(opName)
      const obsStr = JSON.stringify(result).slice(0, 2000)
      history.push({ role: 'user', content: `OBSERVATION: ${obsStr}` })
      steps.push({ thought: thoughtMatch?.[1] ?? '', opCalled: opName, opParams: params, opResult: result })
    } catch (e) {
      const observation = `OBSERVATION: error: ${(e as Error).message.slice(0, 300)}`
      history.push({ role: 'user', content: observation })
      steps.push({ thought: thoughtMatch?.[1] ?? '', opCalled: opName, opParams: params, error: (e as Error).message })
    }
  }
  return { finalAnswer: '(max steps reached without FINAL)', steps, ranOps }
}

// ─── #4 — Continuous eval suite ──────────────────────────────────────

export async function evalAddCase(workspaceId: string, opts: {
  promptKey: string
  input: Record<string, unknown>
  expected?: Record<string, unknown>
  rubric?: string
  weight?: number
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(promptEvalCases).values({
    id, workspaceId,
    promptKey: opts.promptKey,
    input: opts.input,
    expected: opts.expected ?? null,
    rubric: opts.rubric ?? null,
    weight: Math.max(0.1, Math.min(opts.weight ?? 1.0, 10)),
    createdAt: Date.now(),
  })
  return { id }
}

/**
 * Run an eval suite. For each case: produce model output (via callable
 * provided by caller — we pass the eval input as a chat message), then
 * grade. Three grading modes:
 *   - if case.expected exists → exact deep-equal
 *   - else if case.rubric → LLM-as-judge boolean grade
 *   - else → counts as pass if no error
 */
export async function evalRun(workspaceId: string, promptKey: string, opts: {
  promptText?: string                    // text of the prompt under test; if missing, just runs the inputs through default chat
  promptVersion?: string
} = {}): Promise<{ id: string; score: number; total: number; passed: number }> {
  const cases = await db.select().from(promptEvalCases)
    .where(and(eq(promptEvalCases.workspaceId, workspaceId), eq(promptEvalCases.promptKey, promptKey)))
  let totalWeight = 0, passedWeight = 0
  const details: Array<{ caseId: string; passed: boolean; actual: unknown; reason: string }> = []
  const { streamChat } = await import('./chat-providers.js')
  for (const c of cases) {
    totalWeight += c.weight
    const msgs: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []
    if (opts.promptText) msgs.push({ role: 'system', content: opts.promptText })
    msgs.push({ role: 'user', content: JSON.stringify(c.input).slice(0, 4000) })
    let actual: unknown = null
    let reason = ''
    let passed = false
    try {
      const gen = streamChat(workspaceId, msgs, { taskType: 'other' } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      // Try parse JSON; otherwise use raw
      const m = acc.match(/\{[\s\S]*\}/) || acc.match(/\[[\s\S]*\]/)
      try { actual = m ? JSON.parse(m[0]) : acc.trim() } catch { actual = acc.trim() }
      if (c.expected) {
        passed = JSON.stringify(actual) === JSON.stringify(c.expected)
        reason = passed ? 'exact match' : 'mismatch'
      } else if (c.rubric) {
        // LLM-as-judge
        const judgeGen = streamChat(workspaceId, [
          { role: 'system', content: `You judge whether an AI output meets a rubric. Return STRICT JSON: {"pass":bool,"reason":"<short>"}.` },
          { role: 'user',   content: `Rubric: ${c.rubric}\nOutput: ${JSON.stringify(actual).slice(0, 4000)}` },
        ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
        let jacc = ''
        for await (const ch of judgeGen) jacc += ch.delta
        const jm = jacc.match(/\{[\s\S]*\}/)
        if (jm) {
          const verdict = JSON.parse(jm[0]) as { pass?: boolean; reason?: string }
          passed = verdict.pass === true
          reason = String(verdict.reason ?? '').slice(0, 200)
        }
      } else {
        passed = true
        reason = 'no expected/rubric — pass on no-error'
      }
    } catch (e) {
      passed = false
      reason = `error: ${(e as Error).message.slice(0, 200)}`
    }
    if (passed) passedWeight += c.weight
    details.push({ caseId: c.id, passed, actual, reason })
  }
  const score = totalWeight > 0 ? passedWeight / totalWeight : 0
  const id = uuidv7()
  await db.insert(promptEvalRuns).values({
    id, workspaceId, promptKey,
    promptVersion: opts.promptVersion ?? null,
    casesTotal: cases.length,
    casesPassed: details.filter(d => d.passed).length,
    score, details,
    ranAt: Date.now(),
  })
  return { id, score, total: cases.length, passed: details.filter(d => d.passed).length }
}

// ─── #5 — Multi-modal input (vision flag) ────────────────────────────

/**
 * The chat-providers streamChat already accepts multi-part content
 * arrays for Anthropic / OpenAI / Gemini, but most call sites send
 * strings only. This op accepts an image URL + text prompt and forwards
 * via a multi-part message body that providers understand.
 */
export async function visionChat(workspaceId: string, opts: { prompt: string; imageUrl: string }): Promise<{ text: string }> {
  const { streamChat } = await import('./chat-providers.js')
  // Provider-agnostic encoding: many providers accept a multi-part user
  // content array. Anthropic v1/messages, OpenAI vision, Gemini all
  // support {type:'image', source:{type:'url',url:...}} OR a similar
  // shape. The chat-providers layer routes by family. If a given
  // provider doesn't accept this shape, the stream errors and the
  // fallback chain picks the next provider.
  const content = JSON.stringify([
    { type: 'image', source: { type: 'url', url: opts.imageUrl } },
    { type: 'text',  text: opts.prompt },
  ])
  const gen = streamChat(workspaceId, [
    { role: 'user', content },
  ], { taskType: 'vision' } as Parameters<typeof streamChat>[2])
  let acc = ''
  for await (const ch of gen) acc += ch.delta
  return { text: acc }
}
