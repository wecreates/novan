/**
 * R647a — Parallel tool-calling orchestrator.
 *
 * Wraps streamChat in an iteration loop. Each round:
 *   1. Send msgs + tool catalog to the model
 *   2. If model returns tool_use blocks, execute them ALL in parallel via Promise.all
 *   3. Append tool_result messages and re-send
 *   4. When model returns plain text only, return the final text
 *
 * The current chat-providers.streamChat returns text-only. Anthropic/OpenAI/Gemini
 * tool-use protocols differ — for this first cut, we encode tool calls in a JSON
 * envelope the model emits inline (provider-agnostic), then parse + execute. This
 * is the same approach as R633.code-agent: the model says
 *   {"action":"tool_call","tool":"<op>","params":{...}}
 * and we run those before resuming.
 *
 * The model can emit MULTIPLE tool_call objects in one response — they're executed
 * in parallel. This is the operator-asked "parallel tool calling".
 */
import type { ChatMsg } from './chat-providers.js'

const MAX_ROUNDS = 6
const MAX_PARALLEL = 8

const DEFAULT_TOOLS = [
  'research.deep', 'research.youtube_transcript', 'research.arxiv', 'research.reddit',
  'vision.ocr', 'vision.describe', 'vision.chart_extract',
  'code.exec', 'pdf.text_native',
  'rag.query', 'kg.graph.export', 'kg.search',
  'image.free.generate', 'image.free.edit', 'image.bg_remove', 'image.upscale',
  'narrative.story_outline', 'narrative.character_bible',
  'sms.send', 'channel.discord.send', 'channel.telegram.send',
  'memory.recall', 'memory.list',
  'scrape.extract',
]

export interface OrchestrateInput {
  userPrompt:    string
  systemPrompt?: string
  toolsAllowed?: string[]       // operator can restrict to a subset
  maxRounds?:    number
  preferProvider?: string
}

export interface ToolCallTrace {
  round:    number
  tool:     string
  params:   Record<string, unknown>
  ok:       boolean
  durationMs: number
  error?:   string
  resultPreview?: string
}

export interface OrchestrateResult {
  answer:    string
  rounds:    number
  toolCalls: ToolCallTrace[]
  tokens:    number
  costUsd:   number
  latencyMs: number
}

function toolCatalogPrompt(allowed: string[]): string {
  return `You have these tools available. To call one, output a JSON object inline:
  {"action":"tool_call","tool":"<op_name>","params":{...}}

You can emit MULTIPLE tool_call objects in a single response — they execute in parallel.
After tool results return, you can call more tools or produce the final answer.

When you're done, emit exactly:
  {"action":"final","answer":"<your full answer in markdown>"}

Tools:
${allowed.map(t => `  - ${t}`).join('\n')}

Rules: only emit JSON envelopes; no other text outside JSON. Use real op names from the list. Be terse in tool params.`
}

interface ParsedAction {
  tool?:   string
  params?: Record<string, unknown>
  answer?: string
  kind:    'tool_call' | 'final' | 'noise'
  raw:     string
}

function parseActions(text: string): ParsedAction[] {
  const out: ParsedAction[] = []
  // Iterate over balanced { ... } blocks
  let depth = 0, start = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') {
      if (depth === 0) start = i
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        const raw = text.slice(start, i + 1)
        try {
          const obj = JSON.parse(raw) as { action?: string; tool?: string; params?: Record<string, unknown>; answer?: string }
          if (obj.action === 'tool_call' && typeof obj.tool === 'string') {
            out.push({ kind: 'tool_call', tool: obj.tool, params: obj.params ?? {}, raw })
          } else if (obj.action === 'final' && typeof obj.answer === 'string') {
            out.push({ kind: 'final', answer: obj.answer, raw })
          }
        } catch { /* malformed — ignore */ }
        start = -1
      }
    }
  }
  return out
}

async function executeTool(op: string, workspaceId: string, params: Record<string, unknown>, allowed: Set<string>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (!allowed.has(op)) return { ok: false, error: `tool ${op} not in allowed set` }
  try {
    const mod = await import('./brain-task.js') as unknown as { OPERATIONS?: Record<string, { handler: (ws: string, params: Record<string, unknown>) => Promise<unknown> }> }
    const handler = mod.OPERATIONS?.[op]
    if (!handler) return { ok: false, error: `unknown op: ${op}` }
    const result = await handler.handler(workspaceId, params)
    return { ok: true, result }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

function truncatePreview(v: unknown, max = 400): string {
  if (v == null) return ''
  let s: string
  if (typeof v === 'string') s = v
  else { try { s = JSON.stringify(v) } catch { s = String(v) } }
  return s.length > max ? s.slice(0, max) + '…' : s
}

export async function orchestrateTools(workspaceId: string, input: OrchestrateInput): Promise<OrchestrateResult> {
  const t0 = Date.now()
  const allowed = new Set(input.toolsAllowed && input.toolsAllowed.length > 0 ? input.toolsAllowed : DEFAULT_TOOLS)
  const sys = `${input.systemPrompt ?? 'You are Novan. Be concrete, terse, and use tools when they would help.'}\n\n${toolCatalogPrompt([...allowed])}`
  const conversation: ChatMsg[] = [
    { role: 'system', content: sys },
    { role: 'user',   content: input.userPrompt },
  ]
  const trace: ToolCallTrace[] = []
  let totalTokens = 0
  let totalCost = 0
  let answer = ''

  const { streamChat } = await import('./chat-providers.js')
  const maxRounds = Math.max(1, Math.min(MAX_ROUNDS, input.maxRounds ?? MAX_ROUNDS))

  for (let round = 1; round <= maxRounds; round++) {
    let raw = ''
    let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
    const opts: Parameters<typeof streamChat>[2] = { skipUsageTracking: false }
    if (input.preferProvider) opts.preferProvider = input.preferProvider
    const stream = streamChat(workspaceId, conversation, opts)
    let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
    while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
    final = next.value
    totalTokens += final.tokens
    totalCost   += final.costUsd

    const actions = parseActions(raw.trim())
    const finalAction = actions.find(a => a.kind === 'final')
    if (finalAction && finalAction.answer != null) {
      answer = finalAction.answer
      break
    }
    const calls = actions.filter(a => a.kind === 'tool_call').slice(0, MAX_PARALLEL)
    if (calls.length === 0) {
      // Model went off-protocol; treat raw text as answer and exit
      answer = raw.trim()
      break
    }

    // Run all tool_calls in parallel
    const results = await Promise.all(calls.map(async (c, i) => {
      const t = Date.now()
      const r = await executeTool(c.tool!, workspaceId, c.params ?? {}, allowed)
      const dur = Date.now() - t
      const entry: ToolCallTrace = {
        round, tool: c.tool!, params: c.params ?? {}, ok: r.ok, durationMs: dur,
      }
      if (r.error) entry.error = r.error
      if (r.ok)    entry.resultPreview = truncatePreview(r.result)
      trace.push(entry)
      return { i, call: c, ...r }
    }))

    // Append the model's tool_call envelopes + tool_results back into the conversation
    conversation.push({ role: 'assistant', content: raw.trim() })
    const resultsBlock = results.map(r => {
      const slug = `tool_result#${r.i + 1} (${r.call.tool})`
      const body = r.ok ? truncatePreview(r.result, 4000) : `ERROR: ${r.error ?? 'unknown'}`
      return `${slug}: ${body}`
    }).join('\n\n')
    conversation.push({ role: 'user', content: resultsBlock })

    // Loop will resume; if maxRounds reached, the next iter doesn't happen and we
    // surface whatever the model last produced.
    if (round === maxRounds) {
      answer = raw.trim() + '\n\n[reached round cap; no final answer emitted]'
    }
  }

  return {
    answer,
    rounds:    trace.length === 0 ? 1 : Math.max(...trace.map(t => t.round)),
    toolCalls: trace,
    tokens:    totalTokens,
    costUsd:   Number(totalCost.toFixed(6)),
    latencyMs: Date.now() - t0,
  }
}
