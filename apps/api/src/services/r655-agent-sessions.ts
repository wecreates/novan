/**
 * R655 — Agent session continuity.
 *
 * R649 novan.agent is single-shot: each call starts fresh and forgets its
 * own previous turn. Sessions give the operator a thread-like object —
 * goals queued under a sessionId share history so each new agent.turn
 * sees what came before.
 *
 * One table (r655_agent_sessions) + one row-per-turn linkage via
 * r649_agent_runs.session_id. New ops:
 *   - novan.session.create  — open a new thread, optional title + system_prompt
 *   - novan.session.turn    — run novan.agent in the session context (history injected)
 *   - novan.session.list    — recent sessions
 *   - novan.session.get     — single session + its turns
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r655_agent_sessions (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        title         TEXT,
        system_prompt TEXT,
        turn_count    INT NOT NULL DEFAULT 0,
        last_turn_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    // Backfill session_id on r649 if missing
    await db.execute(sql`ALTER TABLE r649_agent_runs ADD COLUMN IF NOT EXISTS session_id TEXT`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r649_agent_runs_session_idx ON r649_agent_runs (session_id, created_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface SessionCreateInput {
  title?:        string
  systemPrompt?: string
}

export interface SessionTurnInput {
  sessionId:     string
  goal:          string
  toolsAllowed?: string[]
  maxLoops?:     number
}

export async function createSession(workspaceId: string, input: SessionCreateInput): Promise<Record<string, unknown>> {
  await ensureDdl()
  const id = `ses_${crypto.randomBytes(8).toString('hex')}`
  try {
    await db.execute(sql`
      INSERT INTO r655_agent_sessions (id, workspace_id, title, system_prompt)
      VALUES (${id}, ${workspaceId}, ${input.title ?? null}, ${input.systemPrompt ?? null})
    `)
  } catch { /* tolerated */ }
  return { id, title: input.title ?? null, systemPrompt: input.systemPrompt ?? null, createdAt: new Date().toISOString() }
}

export async function listSessions(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, title, turn_count, last_turn_at, created_at
      FROM r655_agent_sessions
      WHERE workspace_id = ${workspaceId}
      ORDER BY COALESCE(last_turn_at, created_at) DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function getSession(workspaceId: string, sessionId: string): Promise<Record<string, unknown> | null> {
  await ensureDdl()
  try {
    const sRows = await db.execute(sql`
      SELECT * FROM r655_agent_sessions WHERE id = ${sessionId} AND workspace_id = ${workspaceId} LIMIT 1
    `)
    const session = ((sRows.rows ?? sRows) as Array<Record<string, unknown>>)[0]
    if (!session) return null
    const tRows = await db.execute(sql`
      SELECT id, goal, status, answer, loops, tool_calls, tokens, cost_usd, created_at, finished_at
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
      ORDER BY created_at ASC
    `)
    return { ...session, turns: (tRows.rows ?? tRows) as Array<Record<string, unknown>> }
  } catch { return null }
}

export async function runSessionTurn(workspaceId: string, input: SessionTurnInput): Promise<Record<string, unknown>> {
  await ensureDdl()
  // Pull prior turns + session system prompt
  const session = await getSession(workspaceId, input.sessionId)
  if (!session) throw new Error(`session ${input.sessionId} not found`)
  const turns = (session['turns'] as Array<Record<string, unknown>>) ?? []
  const historyBlock = turns.length === 0 ? '' :
    `\n\nConversation so far in this session:\n` +
    turns.map((t, i) => `  [turn ${i + 1}] goal: "${String(t['goal']).slice(0, 100)}"\n    answer: "${String(t['answer'] ?? '').slice(0, 240)}"`).join('\n')
  const sessionPrompt = session['system_prompt'] ? String(session['system_prompt']) : ''
  const enrichedGoal = `${sessionPrompt ? `[Session context: ${sessionPrompt}]\n` : ''}${input.goal}${historyBlock}`

  const { runAgent } = await import('./r649-agent.js')
  const result = await runAgent(workspaceId, {
    goal: enrichedGoal,
    ...(input.toolsAllowed ? { toolsAllowed: input.toolsAllowed } : {}),
    ...(input.maxLoops ? { maxLoops: input.maxLoops } : {}),
  })

  // Link the resulting run back to the session + bump counters
  try {
    await db.execute(sql`UPDATE r649_agent_runs SET session_id = ${input.sessionId} WHERE id = ${result.runId}`)
    await db.execute(sql`
      UPDATE r655_agent_sessions
      SET turn_count = turn_count + 1, last_turn_at = now()
      WHERE id = ${input.sessionId}
    `)
  } catch { /* tolerated */ }

  return { sessionId: input.sessionId, turnNumber: turns.length + 1, ...result }
}
