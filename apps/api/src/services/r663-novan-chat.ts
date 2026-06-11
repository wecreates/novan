/**
 * R663 — novan.chat: one-shot conversational entry point.
 *
 * Wraps R651 orchestrateToolsNative + R655 sessions + R660 budget into a
 * single op. Caller passes (message, sessionId?). On the first message of
 * a session we create the session row; on subsequent calls we inject prior
 * turns into the user prompt so context flows.
 *
 * Tools are enabled by default (a wide-but-safe set). Caller can override
 * or pass [] to disable tool calls entirely.
 *
 * Stores each turn as a row in r663_chat_turns (separate from agent runs
 * — chat is lighter-weight: no plan/reflect, just tool round + answer).
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const DEFAULT_TOOLS = [
  'web.search', 'web.fetch', 'scrape.extract',
  'github.repo', 'github.release', 'github.readme',
  'brain.list', 'memory.recall', 'memory.list',
  'rag.query', 'kg.search',
  'vision.openai.describe',
]

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r663_chat_turns (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        session_id    TEXT,
        user_message  TEXT NOT NULL,
        assistant_msg TEXT,
        tool_calls    INT NOT NULL DEFAULT 0,
        tokens        INT NOT NULL DEFAULT 0,
        cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
        latency_ms    INT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r663_chat_session_idx ON r663_chat_turns (session_id, created_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface ChatInput {
  message:       string
  sessionId?:    string
  systemPrompt?: string
  toolsAllowed?: string[]
  maxRounds?:    number
}

export interface ChatOutput {
  turnId:      string
  sessionId:   string
  answer:      string
  toolCalls:   number
  tokens:      number
  costUsd:     number
  latencyMs:   number
}

export async function chat(workspaceId: string, input: ChatInput): Promise<ChatOutput> {
  await ensureDdl()
  if (!input.message?.trim()) throw new Error('message required')

  // R660 budget cap applies to chat too
  const { assertWithinBudget } = await import('./r660-agent-budget.js')
  await assertWithinBudget(workspaceId)

  const t0 = Date.now()
  let sessionId = input.sessionId ?? ''
  if (!sessionId) sessionId = `chs_${crypto.randomBytes(8).toString('hex')}`

  // Pull last 6 turns of history for context
  let priorTurns: Array<Record<string, unknown>> = []
  try {
    const rows = await db.execute(sql`
      SELECT user_message, assistant_msg
      FROM r663_chat_turns
      WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
      ORDER BY created_at DESC LIMIT 6
    `)
    priorTurns = ((rows.rows ?? rows) as Array<Record<string, unknown>>).reverse()
  } catch { /* fresh session */ }

  const historyBlock = priorTurns.length === 0 ? '' :
    `Prior turns in this session:\n` +
    priorTurns.map(t => `User: ${String(t['user_message']).slice(0, 400)}\nAssistant: ${String(t['assistant_msg'] ?? '').slice(0, 400)}`).join('\n\n') +
    `\n\n---\nNew user message:\n`

  const tools = input.toolsAllowed ?? DEFAULT_TOOLS
  const { orchestrateToolsNative } = await import('./r651-native-tools.js')
  const r = await orchestrateToolsNative(workspaceId, {
    userPrompt: historyBlock + input.message,
    systemPrompt: input.systemPrompt ?? 'You are Novan, a helpful autonomous assistant. Use tools when they would give better/fresher answers than your training data. Be terse.',
    toolsAllowed: tools,
    maxRounds:    input.maxRounds ?? 4,
  })

  const turnId = `cht_${crypto.randomBytes(8).toString('hex')}`
  const latencyMs = Date.now() - t0
  try {
    await db.execute(sql`
      INSERT INTO r663_chat_turns (id, workspace_id, session_id, user_message, assistant_msg, tool_calls, tokens, cost_usd, latency_ms)
      VALUES (${turnId}, ${workspaceId}, ${sessionId}, ${input.message}, ${r.answer}, ${r.toolCalls.length}, ${r.tokens}, ${r.costUsd}, ${latencyMs})
    `)
  } catch { /* tolerated */ }

  return {
    turnId,
    sessionId,
    answer: r.answer,
    toolCalls: r.toolCalls.length,
    tokens: r.tokens,
    costUsd: r.costUsd,
    latencyMs,
  }
}

export async function listChatSessions(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT session_id,
             count(*)::int AS turns,
             min(created_at) AS started_at,
             max(created_at) AS last_at,
             COALESCE(sum(cost_usd), 0)::numeric(12,6) AS cost_usd
      FROM r663_chat_turns
      WHERE workspace_id = ${workspaceId}
      GROUP BY session_id
      ORDER BY max(created_at) DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function getChatSession(workspaceId: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, user_message, assistant_msg, tool_calls, tokens, cost_usd, latency_ms, created_at
      FROM r663_chat_turns
      WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
      ORDER BY created_at ASC
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}
