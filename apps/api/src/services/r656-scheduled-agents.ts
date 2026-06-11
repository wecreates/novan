/**
 * R656 — Scheduled novan.agent goals.
 *
 * Operator registers `(goal, intervalSec, toolsAllowed)`. A background cron
 * tick (wired into learning-cron) wakes every minute, finds rows whose
 * next_run_at is in the past, fires novan.agent on each, and updates the
 * schedule. Each invocation persists as a normal r649_agent_run row tagged
 * with schedule_id so the operator can inspect history per schedule.
 *
 * Use case: "every 6h check competitor pricing", "every morning summarize
 * yesterday's revenue", "every hour scan ai_usage for spend anomalies".
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const MAX_PARALLEL_FIRES = 4

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r656_agent_schedules (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL,
        title           TEXT,
        goal            TEXT NOT NULL,
        tools_allowed   JSONB,
        interval_sec    INT NOT NULL,
        enabled         BOOLEAN NOT NULL DEFAULT true,
        next_run_at     TIMESTAMPTZ NOT NULL,
        last_run_at     TIMESTAMPTZ,
        last_run_id     TEXT,
        last_status     TEXT,
        run_count       INT NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`ALTER TABLE r649_agent_runs ADD COLUMN IF NOT EXISTS schedule_id TEXT`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r656_sched_next_idx ON r656_agent_schedules (enabled, next_run_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface ScheduleInput {
  title?:        string
  goal:          string
  intervalSec:   number
  toolsAllowed?: string[]
  startInSec?:   number
}

export async function createSchedule(workspaceId: string, input: ScheduleInput): Promise<Record<string, unknown>> {
  await ensureDdl()
  if (!input.goal) throw new Error('goal required')
  const interval = Math.max(60, Math.min(86400, Math.floor(input.intervalSec)))
  const id = `sch_${crypto.randomBytes(8).toString('hex')}`
  const startInSec = Math.max(0, input.startInSec ?? 0)
  try {
    await db.execute(sql`
      INSERT INTO r656_agent_schedules (id, workspace_id, title, goal, tools_allowed, interval_sec, next_run_at)
      VALUES (${id}, ${workspaceId}, ${input.title ?? null}, ${input.goal},
              ${input.toolsAllowed ? JSON.stringify(input.toolsAllowed) : null}::jsonb,
              ${interval},
              now() + (${startInSec} || ' seconds')::interval)
    `)
  } catch (e) {
    throw new Error(`createSchedule failed: ${(e as Error).message}`)
  }
  return { id, intervalSec: interval, startInSec, enabled: true }
}

export async function listSchedules(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, title, goal, interval_sec, enabled, next_run_at, last_run_at, last_status, run_count, created_at
      FROM r656_agent_schedules
      WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function setScheduleEnabled(workspaceId: string, id: string, enabled: boolean): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`
      UPDATE r656_agent_schedules SET enabled = ${enabled}
      WHERE id = ${id} AND workspace_id = ${workspaceId}
    `)
    return { ok: true }
  } catch { return { ok: false } }
}

export async function deleteSchedule(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`DELETE FROM r656_agent_schedules WHERE id = ${id} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}

/** Called by learning-cron tick. Claims due rows, fires novan.agent, advances schedule. */
export async function tickScheduledAgents(): Promise<{ fired: number; errors: number; nextDue?: string }> {
  await ensureDdl()
  let due: Array<Record<string, unknown>> = []
  try {
    const rows = await db.execute(sql`
      SELECT id, workspace_id, goal, tools_allowed, interval_sec
      FROM r656_agent_schedules
      WHERE enabled = true AND next_run_at <= now()
      ORDER BY next_run_at ASC
      LIMIT ${MAX_PARALLEL_FIRES}
      FOR UPDATE SKIP LOCKED
    `)
    due = (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { /* table may not exist yet */ }

  if (due.length === 0) {
    let nextDue: string | undefined
    try {
      const nRows = await db.execute(sql`SELECT min(next_run_at) AS n FROM r656_agent_schedules WHERE enabled = true`)
      const v = ((nRows.rows ?? nRows) as Array<Record<string, unknown>>)[0]?.['n']
      if (v) nextDue = String(v)
    } catch { /* ignore */ }
    const result: { fired: number; errors: number; nextDue?: string } = { fired: 0, errors: 0 }
    if (nextDue) result.nextDue = nextDue
    return result
  }

  const { runAgent } = await import('./r649-agent.js')
  let fired = 0, errors = 0
  await Promise.all(due.map(async (row) => {
    const id = String(row['id'])
    const workspaceId = String(row['workspace_id'])
    const goal = String(row['goal'])
    const intervalSec = Number(row['interval_sec'])
    const tools = row['tools_allowed'] as string[] | null
    try {
      const result = await runAgent(workspaceId, {
        goal,
        ...(tools && Array.isArray(tools) ? { toolsAllowed: tools } : {}),
      })
      // link run → schedule + advance
      try {
        await db.execute(sql`UPDATE r649_agent_runs SET schedule_id = ${id} WHERE id = ${result.runId}`)
      } catch { /* tolerated */ }
      await db.execute(sql`
        UPDATE r656_agent_schedules
        SET last_run_at = now(),
            last_run_id = ${result.runId},
            last_status = ${result.done ? 'done' : 'capped'},
            run_count = run_count + 1,
            next_run_at = now() + (${intervalSec} || ' seconds')::interval
        WHERE id = ${id}
      `)
      fired++
    } catch (e) {
      errors++
      try {
        await db.execute(sql`
          UPDATE r656_agent_schedules
          SET last_run_at = now(),
              last_status = ${'error: ' + ((e as Error).message ?? '').slice(0, 200)},
              run_count = run_count + 1,
              next_run_at = now() + (${intervalSec} || ' seconds')::interval
          WHERE id = ${id}
        `)
      } catch { /* tolerated */ }
    }
  }))

  return { fired, errors }
}
