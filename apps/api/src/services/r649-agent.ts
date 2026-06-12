/**
 * R649 — Novan autonomous agent loop.
 *
 * One op (novan.agent) takes a goal and drives a Plan → Act → Reflect loop
 * until the model says it's done or the round cap is hit. Built on:
 *   - R648 chat.with_schema_native  — for the planning + reflection JSON
 *   - R647a orchestrateTools        — for the parallel-tool execution rounds
 *   - R646 plans                    — persisted as the agent's checkpoint trail
 *
 * Loop:
 *   1. PLAN  — ask the model for a structured {subgoal, tools_needed[]} list
 *   2. ACT   — orchestrateTools runs the parallel tool calls per round
 *   3. REFLECT — ask {done: bool, next_subgoal?: string, answer?: string}
 *   4. If done → return answer. Else → goto ACT with next_subgoal.
 *
 * Persists every step to r649_agent_runs so the operator can replay,
 * resume, or audit any past run.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const MAX_LOOPS    = 8
const DEFAULT_TOOLS = [
  'brain.list',
  'web.fetch', 'scrape.extract',
  'research.deep', 'research.youtube_transcript', 'research.arxiv', 'research.reddit',
  'vision.ocr', 'vision.describe',
  'rag.query', 'kg.search', 'kg.mermaid',
  'memory.recall', 'memory.list',
  'desktop.act',
]

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r649_agent_runs (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        goal         TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'running',
        answer       TEXT,
        loops        INT  NOT NULL DEFAULT 0,
        tool_calls   INT  NOT NULL DEFAULT 0,
        tokens       INT  NOT NULL DEFAULT 0,
        cost_usd     NUMERIC(12,6) NOT NULL DEFAULT 0,
        trace        JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at  TIMESTAMPTZ
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface AgentInput {
  goal:          string
  toolsAllowed?: string[]
  maxLoops?:     number
  preferProvider?: 'anthropic' | 'openai' | 'auto'
  /** R661 — optional SSE-style callback fired on every plan/act/reflect step. */
  onEvent?:      (event: { kind: 'plan' | 'act' | 'reflect' | 'evidence' | 'done' | 'error'; round: number; data: Record<string, unknown> }) => void
}

export interface AgentResult {
  runId:      string
  goal:       string
  answer:     string
  done:       boolean
  loops:      number
  toolCalls:  number
  tokens:     number
  costUsd:    number
  latencyMs:  number
  trace:      Array<{ phase: 'plan' | 'act' | 'reflect'; round: number; summary: string }>
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    subgoal:       { type: 'string' },
    reasoning:     { type: 'string' },
    tools_needed:  { type: 'array', items: { type: 'string' } },
  },
}

const REFLECT_SCHEMA = {
  type: 'object',
  properties: {
    done:          { type: 'boolean' },
    answer:        { type: 'string' },
    next_subgoal:  { type: 'string' },
    reasoning:     { type: 'string' },
  },
}

export async function runAgent(workspaceId: string, input: AgentInput): Promise<AgentResult> {
  await ensureDdl()
  // R660 — enforce per-workspace daily budget before any LLM call
  const { assertWithinBudget } = await import('./r660-agent-budget.js')
  await assertWithinBudget(workspaceId)
  const t0 = Date.now()
  const runId = `agn_${crypto.randomBytes(8).toString('hex')}`
  const maxLoops = Math.max(1, Math.min(MAX_LOOPS, input.maxLoops ?? MAX_LOOPS))
  const allowed  = input.toolsAllowed?.length ? input.toolsAllowed : DEFAULT_TOOLS
  const trace: AgentResult['trace'] = []
  let totalTokens = 0, totalCost = 0, totalToolCalls = 0

  await db.execute(sql`
    INSERT INTO r649_agent_runs (id, workspace_id, goal, status, trace)
    VALUES (${runId}, ${workspaceId}, ${input.goal}, 'running', '[]'::jsonb)
  `).catch(() => {})

  const { withSchemaNative } = await import('./r648-native-schema.js')
  // R651 — prefer native OpenAI tool calling; falls back internally to R647a if no key
  const { orchestrateToolsNative } = await import('./r651-native-tools.js')

  // R653 — recall past similar runs so the agent compounds on prior knowledge
  const priorRuns = await findSimilarRuns(workspaceId, input.goal, 3)
  const priorBlock = priorRuns.length === 0 ? '' :
    `\n\nPrior similar runs in this workspace (most recent first):\n` +
    priorRuns.map(r => `  - goal="${String(r['goal']).slice(0, 100)}" status=${r['status']} answer="${String(r['answer'] ?? '').slice(0, 240)}"`).join('\n') +
    `\n\nIf one of these already answers the current goal, you may complete in one loop by citing the prior answer (but verify with a tool call first if the value could have changed since).`

  let answer = ''
  let done = false
  let currentSubgoal = input.goal
  let loop = 0
  // R650 — accumulate real tool evidence the reflector + final answer can use
  const evidence: Array<{ round: number; tool: string; preview: string }> = []

  for (loop = 1; loop <= maxLoops; loop++) {
    // R671 — fast-path: skip PLAN on simple goals.
    // Trigger: goal ≤ 200 chars, exactly 1–2 allowed tools, no prior turns
    // referenced. The orchestrator (ACT) is already a planner-of-sorts via
    // tool_choice:auto, so the PLAN call is redundant for trivial asks.
    const fastPath = loop === 1
      && input.goal.length <= 200
      && allowed.length >= 1 && allowed.length <= 2

    let planSubgoal: string
    let planTools: string[]
    if (fastPath) {
      planSubgoal = input.goal
      planTools = allowed
      trace.push({ phase: 'plan', round: loop, summary: `fast-path · tools=${allowed.join(',')}` })
      try { input.onEvent?.({ kind: 'plan', round: loop, data: { subgoal: planSubgoal, tools_needed: planTools, fastPath: true } }) } catch { /* tolerated */ }
    } else {
      // 1. PLAN — R669 tightened prompt
      const plan = await withSchemaNative(workspaceId, {
        prompt: `Goal: ${input.goal}\nStep: ${currentSubgoal}\nTools: ${allowed.join(',')}${priorBlock}`,
        schema: PLAN_SCHEMA,
        systemPrompt: 'Plan one concrete step. JSON.',
        ...(input.preferProvider ? { preferProvider: input.preferProvider } : {}),
      })
      totalTokens += plan.tokens
      totalCost   += plan.costUsd
      if (!plan.ok) {
        trace.push({ phase: 'plan', round: loop, summary: `PLAN failed: ${plan.error}` })
        break
      }
      const planData = plan.data as { subgoal?: string; reasoning?: string; tools_needed?: string[] }
      planSubgoal = planData.subgoal ?? currentSubgoal
      planTools = (planData.tools_needed ?? []).filter(t => allowed.includes(t))
      trace.push({ phase: 'plan', round: loop, summary: `subgoal=${planSubgoal} · tools=${planTools.join(',')}` })
      try { input.onEvent?.({ kind: 'plan', round: loop, data: { subgoal: planSubgoal, tools_needed: planTools, reasoning: planData.reasoning } }) } catch { /* tolerated */ }
    }

    // 2. ACT
    const toolsForRound = planTools
    let actAnswer = ''
    let actDidWork = false
    if (toolsForRound.length === 0) {
      trace.push({ phase: 'act', round: loop, summary: 'no tools requested — skipping act' })
    } else {
      const act = await orchestrateToolsNative(workspaceId, {
        userPrompt:   planSubgoal,
        systemPrompt: 'Use the provided tools to gather what you need. Be terse. Cite real values.',
        toolsAllowed: toolsForRound,
        maxRounds:    2,
      })
      totalTokens    += act.tokens
      totalCost      += act.costUsd
      totalToolCalls += act.toolCalls.length
      actAnswer = act.answer ?? ''
      actDidWork = act.toolCalls.length > 0
      // R669 — was 1200, model rarely needs more than 400 chars per tool to ground its answer
      for (const c of act.toolCalls) {
        if (c.ok && c.resultPreview) evidence.push({ round: loop, tool: c.tool, preview: c.resultPreview.slice(0, 400) })
      }
      trace.push({ phase: 'act', round: loop, summary: `ran ${act.toolCalls.length} tool(s) over ${act.rounds} rounds: ${act.toolCalls.map(c => `${c.tool}${c.ok ? '✓' : '✗'}`).join(', ')}` })
      try { input.onEvent?.({ kind: 'act', round: loop, data: { tool_calls: act.toolCalls.map(c => ({ tool: c.tool, ok: c.ok, ms: c.durationMs })), rounds: act.rounds } }) } catch { /* tolerated */ }
    }

    // R673 — skip REFLECT entirely when ACT already produced a substantive
    // answer grounded in tool evidence. The orchestrator's final assistant
    // message IS the reflection — running another LLM call would only
    // re-confirm what we already have. Saves ~300-500 tokens per loop.
    const actAnswerLooksDone = actDidWork && actAnswer.length >= 12 && !actAnswer.toLowerCase().includes('error')
    if (actAnswerLooksDone) {
      done = true
      answer = actAnswer
      trace.push({ phase: 'reflect', round: loop, summary: 'fast-finish: ACT answer accepted (REFLECT skipped)' })
      try { input.onEvent?.({ kind: 'reflect', round: loop, data: { done: true, fastFinish: true } }) } catch { /* tolerated */ }
      break
    }

    // 3. REFLECT — only when ACT didn't produce a usable answer (no tools
    // were run, or the model just confirmed without grounding).
    const evidenceBlock = evidence.length === 0 ? '' :
      'Evidence:\n' + evidence.map(e => `[${e.tool}#${e.round}] ${e.preview}`).join('\n') + '\n'
    const reflect = await withSchemaNative(workspaceId, {
      prompt: `Goal: ${input.goal}\nJust did: ${planSubgoal}\n${evidenceBlock}Done? If yes, set done=true + answer (cite concrete values from evidence, no placeholders). Else done=false + next_subgoal.`,
      schema: REFLECT_SCHEMA,
      systemPrompt: 'Reflect. Cite real values, never placeholders. JSON.',
      ...(input.preferProvider ? { preferProvider: input.preferProvider } : {}),
    })
    totalTokens += reflect.tokens
    totalCost   += reflect.costUsd
    if (!reflect.ok) {
      trace.push({ phase: 'reflect', round: loop, summary: `REFLECT failed: ${reflect.error}` })
      break
    }
    const r = reflect.data as { done?: boolean; answer?: string; next_subgoal?: string; reasoning?: string }
    trace.push({ phase: 'reflect', round: loop, summary: `done=${r.done} · ${r.reasoning?.slice(0, 80) ?? ''}` })
    try { input.onEvent?.({ kind: 'reflect', round: loop, data: { done: !!r.done, reasoning: r.reasoning, next_subgoal: r.next_subgoal } }) } catch { /* tolerated */ }

    if (r.done) {
      done = true
      answer = r.answer ?? ''
      break
    }
    currentSubgoal = r.next_subgoal ?? currentSubgoal
  }
  try { input.onEvent?.({ kind: 'done', round: loop, data: { answer, done } }) } catch { /* tolerated */ }

  if (!done && !answer) {
    answer = `[reached loop cap (${maxLoops}) without a final answer]\n\nLast subgoal: ${currentSubgoal}`
  }

  const latencyMs = Date.now() - t0
  try {
    await db.execute(sql`
      UPDATE r649_agent_runs
      SET status = ${done ? 'done' : 'capped'},
          answer = ${answer},
          loops = ${loop},
          tool_calls = ${totalToolCalls},
          tokens = ${totalTokens},
          cost_usd = ${Number(totalCost.toFixed(6))},
          trace = ${JSON.stringify(trace)}::jsonb,
          finished_at = now()
      WHERE id = ${runId}
    `)
  } catch { /* tolerated */ }

  return {
    runId, goal: input.goal, answer, done,
    loops: loop, toolCalls: totalToolCalls,
    tokens: totalTokens, costUsd: Number(totalCost.toFixed(6)),
    latencyMs, trace,
  }
}

/** R653 — surface past runs whose goal shares ≥2 keyword tokens with this one. */
export async function findSimilarRuns(workspaceId: string, goal: string, limit = 3): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  const tokens = goal.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4).slice(0, 8)
  if (tokens.length === 0) return []
  try {
    // Pull recent done/capped runs, score by token overlap in JS — keeps SQL simple
    const rows = await db.execute(sql`
      SELECT id, goal, status, answer, loops, tool_calls, created_at
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND status IN ('done', 'capped')
      ORDER BY created_at DESC LIMIT 100
    `)
    const all = (rows.rows ?? rows) as Array<Record<string, unknown>>
    const scored = all.map(r => {
      const g = String(r['goal'] ?? '').toLowerCase()
      const matches = tokens.filter(t => g.includes(t)).length
      return { row: r, score: matches }
    }).filter(s => s.score >= 2)
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(s => s.row)
  } catch { return [] }
}

export async function listAgentRuns(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, goal, status, loops, tool_calls, tokens, cost_usd, created_at, finished_at
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function getAgentRun(workspaceId: string, runId: string): Promise<Record<string, unknown> | null> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT * FROM r649_agent_runs
      WHERE id = ${runId} AND workspace_id = ${workspaceId}
      LIMIT 1
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0] ?? null
  } catch { return null }
}

export async function renderAgentsHtml(workspaceId: string): Promise<string> {
  const runs = await listAgentRuns(workspaceId, 100)
  const rows = runs.map(r => `
    <tr>
      <td><code>${String(r['id']).slice(0, 12)}</code></td>
      <td>${r['status']}</td>
      <td>${escapeHtml(String(r['goal']).slice(0, 100))}</td>
      <td>${r['loops']}</td>
      <td>${r['tool_calls']}</td>
      <td>${r['tokens']}</td>
      <td>$${Number(r['cost_usd'] ?? 0).toFixed(4)}</td>
      <td>${String(r['created_at']).slice(0, 16)}</td>
    </tr>`).join('')
  return `<!doctype html><html><head><title>R649 agent runs</title>
    <style>body{font:14px system-ui;max-width:1200px;margin:2rem auto;padding:1rem}
    table{width:100%;border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left;font-size:13px}
    th{background:#f7f7f7}.s{font:13px monospace;color:#555}</style></head>
    <body><h1>R649 novan.agent runs</h1>
    <p class="s">${runs.length} runs · autonomous plan→act→reflect loop</p>
    <!-- R649 -->
    <table><thead><tr><th>id</th><th>status</th><th>goal</th><th>loops</th><th>tools</th><th>tokens</th><th>cost</th><th>created</th></tr></thead>
    <tbody>${rows}</tbody></table></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
