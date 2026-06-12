/**
 * R651 — Provider-native tool calling.
 *
 * R647a orchestrator drives tool use with a prompt-layer JSON envelope
 * ({"action":"tool_call",...}) — fragile, no typing on params, model
 * occasionally drifts off-protocol. This module uses OpenAI's native
 * tool-calling API (and the parallel_tool_calls flag) so:
 *   - tool calls are guaranteed-extractable (no JSON parsing)
 *   - params are typed via a JSON Schema per tool
 *   - multiple tools per round arrive structurally, not via regex
 *
 * Tool schemas are minimal: every brain op accepts a free-form `params`
 * object, so we expose each tool as `{ name, description, parameters:
 * { type: 'object', properties: { params: { type: 'object' } } } }`.
 * The op's own description tells the model what params it wants.
 *
 * Falls back to R647a prompt-layer when OPENAI_API_KEY is missing.
 */

const MAX_ROUNDS = 6
const MAX_PARALLEL = 8

const DEFAULT_TOOLS = [
  'brain.list',
  'web.fetch', 'scrape.extract',
  'research.deep', 'research.youtube_transcript', 'research.arxiv', 'research.reddit',
  'vision.ocr', 'vision.describe',
  'rag.query', 'kg.search',
  'memory.recall', 'memory.list',
]

export interface NativeToolsInput {
  userPrompt:    string
  systemPrompt?: string
  toolsAllowed?: string[]
  maxRounds?:    number
  model?:        string
}

export interface NativeToolsResult {
  answer:    string
  rounds:    number
  toolCalls: Array<{ round: number; tool: string; params: Record<string, unknown>; ok: boolean; durationMs: number; error?: string; resultPreview?: string }>
  tokens:    number
  costUsd:   number
  latencyMs: number
  fellBack?: boolean
}

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

interface OAIToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

function truncatePreview(v: unknown, max = 400): string {
  if (v == null) return ''
  let s: string
  if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v) } catch { s = String(v) } }
  return s.length > max ? s.slice(0, max) + '…' : s
}

async function loadOpRegistry(): Promise<Record<string, { description: string; handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }>> {
  const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, { description?: string; handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }> }
  return mod.OPERATIONS ?? {}
}

function buildToolDefs(allowed: string[], registry: Awaited<ReturnType<typeof loadOpRegistry>>): OAIToolDef[] {
  // OpenAI requires function names to match ^[a-zA-Z0-9_-]+$. Brain ops use
  // dots ('brain.list'); we substitute to underscores in the function name
  // and remember the mapping so we can route results back to the real op.
  return allowed
    .filter(op => registry[op])
    .map(op => ({
      type: 'function' as const,
      function: {
        name: op.replace(/\./g, '__'),
        description: (registry[op]?.description ?? `Run the ${op} brain op.`).slice(0, 400),
        parameters: {
          type: 'object',
          properties: {
            params: {
              type: 'object',
              description: 'Parameters for this op. See the op description for the exact shape.',
              additionalProperties: true,
            },
          },
          required: ['params'],
          additionalProperties: false,
        },
      },
    }))
}

export async function orchestrateToolsNative(workspaceId: string, input: NativeToolsInput): Promise<NativeToolsResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    // Fallback to R647a
    const { orchestrateTools } = await import('./r647-tool-orchestrator.js')
    const fb = await orchestrateTools(workspaceId, {
      userPrompt: input.userPrompt,
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.toolsAllowed ? { toolsAllowed: input.toolsAllowed } : {}),
      ...(input.maxRounds ? { maxRounds: input.maxRounds } : {}),
    })
    return { ...fb, fellBack: true }
  }

  const model = input.model ?? 'gpt-4o-mini'
  const allowed = input.toolsAllowed?.length ? input.toolsAllowed : DEFAULT_TOOLS
  const allowedSet = new Set(allowed)
  const registry = await loadOpRegistry()
  const tools = buildToolDefs(allowed, registry)
  const maxRounds = Math.max(1, Math.min(MAX_ROUNDS, input.maxRounds ?? MAX_ROUNDS))

  const messages: OAIMessage[] = [
    { role: 'system', content: input.systemPrompt ?? 'You are Novan. Use the provided tools when they help. Be terse.' },
    { role: 'user',   content: input.userPrompt },
  ]
  const toolCalls: NativeToolsResult['toolCalls'] = []
  let totalInputTokens = 0, totalOutputTokens = 0
  let answer = ''
  let rounds = 0

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    const body: Record<string, unknown> = {
      model,
      messages,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      answer = `[openai ${res.status}: ${errText.slice(0, 300)}]`
      break
    }
    const j = await res.json() as {
      choices?: Array<{ message?: OAIMessage; finish_reason?: string }>
      usage?:   { prompt_tokens?: number; completion_tokens?: number }
    }
    totalInputTokens  += j.usage?.prompt_tokens ?? 0
    totalOutputTokens += j.usage?.completion_tokens ?? 0
    const msg = j.choices?.[0]?.message
    if (!msg) { answer = '[openai returned no message]'; break }

    // Push assistant turn before tool results (required by OpenAI API)
    messages.push(msg)

    const calls = (msg.tool_calls ?? []).slice(0, MAX_PARALLEL)
    if (calls.length === 0) {
      answer = msg.content ?? ''
      break
    }

    // Execute all tool calls in parallel
    const results = await Promise.all(calls.map(async (c) => {
      const op = c.function.name.replace(/__/g, '.')
      const tStart = Date.now()
      let params: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(c.function.arguments || '{}') as { params?: Record<string, unknown> } & Record<string, unknown>
        params = parsed.params && typeof parsed.params === 'object' ? parsed.params : (parsed as Record<string, unknown>)
      } catch { /* keep empty */ }
      if (!allowedSet.has(op)) {
        const entry: typeof toolCalls[number] = { round, tool: op, params, ok: false, durationMs: 0, error: `not in allowed set` }
        toolCalls.push(entry)
        return { id: c.id, name: c.function.name, content: `ERROR: tool ${op} not allowed` }
      }
      const handler = registry[op]?.handler
      if (!handler) {
        const entry: typeof toolCalls[number] = { round, tool: op, params, ok: false, durationMs: 0, error: 'unknown op' }
        toolCalls.push(entry)
        return { id: c.id, name: c.function.name, content: `ERROR: unknown op ${op}` }
      }
      try {
        // R665 — cache safe-to-cache reads within a short TTL
        const { withToolCache } = await import('./r665-tool-cache.js')
        const { value: result, cacheHit } = await withToolCache(op, workspaceId, params, () => handler(workspaceId, params))
        const dur = Date.now() - tStart
        const preview = truncatePreview(result, 4000)
        const entry: typeof toolCalls[number] = { round, tool: op, params, ok: true, durationMs: dur, resultPreview: truncatePreview(result) }
        if (cacheHit) entry.resultPreview = `[CACHED] ${entry.resultPreview ?? ''}`
        toolCalls.push(entry)
        return { id: c.id, name: c.function.name, content: preview }
      } catch (e) {
        const dur = Date.now() - tStart
        const msg = (e as Error).message ?? String(e)
        const entry: typeof toolCalls[number] = { round, tool: op, params, ok: false, durationMs: dur, error: msg }
        toolCalls.push(entry)
        return { id: c.id, name: c.function.name, content: `ERROR: ${msg}` }
      }
    }))

    // Append tool result messages
    for (const r of results) {
      messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content })
    }

    // If we've hit the cap, the loop will exit; surface any assistant content
    if (round === maxRounds && !answer) {
      answer = msg.content ?? '[reached round cap]'
    }
  }

  const costUsd = (totalInputTokens / 1_000_000) * 0.15 + (totalOutputTokens / 1_000_000) * 0.60
  return {
    answer,
    rounds,
    toolCalls,
    tokens: totalInputTokens + totalOutputTokens,
    costUsd: Number(costUsd.toFixed(6)),
    latencyMs: Date.now() - t0,
  }
}
