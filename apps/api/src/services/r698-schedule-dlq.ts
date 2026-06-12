/**
 * R698 — Dead-letter queue for failed scheduled agents.
 *
 * R656 schedules just retry next interval when an agent errors. R698 tracks
 * consecutive failures per schedule and auto-disables after `MAX_CONSECUTIVE_ERRORS`
 * (default 3), firing R686 notify so the operator hears about it.
 *
 * Hooks into the existing r656_agent_schedules.last_status — a status that
 * starts with "error:" counts as a failure; "done" or "capped" resets the counter.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const MAX_CONSECUTIVE_ERRORS = Number(process.env['R698_MAX_CONSECUTIVE_ERRORS'] ?? 3)

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`ALTER TABLE r656_agent_schedules ADD COLUMN IF NOT EXISTS consecutive_errors INT NOT NULL DEFAULT 0`).catch(() => {})
    await db.execute(sql`ALTER TABLE r656_agent_schedules ADD COLUMN IF NOT EXISTS dlq_at TIMESTAMPTZ`).catch(() => {})
    await db.execute(sql`ALTER TABLE r656_agent_schedules ADD COLUMN IF NOT EXISTS dlq_reason TEXT`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export async function recordScheduleOutcome(scheduleId: string, status: string): Promise<{ disabled: boolean; consecutive: number }> {
  await ensureDdl()
  const isFailure = status.startsWith('error') || status === 'capped'
  try {
    if (!isFailure) {
      await db.execute(sql`UPDATE r656_agent_schedules SET consecutive_errors = 0 WHERE id = ${scheduleId}`)
      return { disabled: false, consecutive: 0 }
    }
    const rows = await db.execute(sql`
      UPDATE r656_agent_schedules
      SET consecutive_errors = consecutive_errors + 1
      WHERE id = ${scheduleId}
      RETURNING consecutive_errors, workspace_id, goal, title
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    const consecutive = Number(r?.['consecutive_errors'] ?? 0)
    if (consecutive >= MAX_CONSECUTIVE_ERRORS) {
      const reason = `R698: ${consecutive} consecutive failures (last status: ${status.slice(0, 100)})`
      await db.execute(sql`
        UPDATE r656_agent_schedules
        SET enabled = false, dlq_at = now(), dlq_reason = ${reason}
        WHERE id = ${scheduleId}
      `)
      // Notify the operator
      try {
        const { notifyAgentCompletion } = await import('./r686-agent-notify.js')
        await notifyAgentCompletion({
          workspaceId: String(r?.['workspace_id'] ?? 'default'),
          runId: `r698_dlq_${scheduleId.slice(0, 12)}`,
          goal: `[R698 schedule DLQ] "${String(r?.['title'] ?? r?.['goal'] ?? scheduleId).slice(0, 120)}"`,
          answer: reason,
          status: 'error',
          costUsd: 0, tokens: 0,
          scheduleId,
        })
      } catch { /* tolerated */ }
      return { disabled: true, consecutive }
    }
    return { disabled: false, consecutive }
  } catch { return { disabled: false, consecutive: 0 } }
}

export async function listDlqSchedules(workspaceId: string): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, title, goal, consecutive_errors, dlq_at, dlq_reason, last_status, run_count
      FROM r656_agent_schedules
      WHERE workspace_id = ${workspaceId} AND dlq_at IS NOT NULL
      ORDER BY dlq_at DESC
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function reviveSchedule(workspaceId: string, scheduleId: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`
      UPDATE r656_agent_schedules
      SET enabled = true, dlq_at = NULL, dlq_reason = NULL, consecutive_errors = 0
      WHERE id = ${scheduleId} AND workspace_id = ${workspaceId}
    `)
    return { ok: true }
  } catch { return { ok: false } }
}
