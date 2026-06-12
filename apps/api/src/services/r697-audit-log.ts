/**
 * R697 — Audit log for security-relevant actions.
 *
 * Persists every admin dispatch, auth event, webhook fire, billing event,
 * tier change, etc. Append-only table with no UPDATE / DELETE ops exposed.
 * Queryable by actor / event / time range.
 *
 * Used by: server.ts admin middleware, R689 auth routes, R693 billing,
 * R678 webhook receiver, R686 notify outbound, R692 backup runs.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r697_audit_log (
        id           TEXT PRIMARY KEY,
        ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor_type   TEXT NOT NULL,
        actor_id     TEXT,
        event        TEXT NOT NULL,
        workspace_id TEXT,
        ip           TEXT,
        user_agent   TEXT,
        outcome      TEXT NOT NULL,
        details      JSONB
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r697_audit_event_idx ON r697_audit_log (event, ts DESC)`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r697_audit_actor_idx ON r697_audit_log (actor_type, actor_id, ts DESC)`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r697_audit_ws_idx ON r697_audit_log (workspace_id, ts DESC)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export interface AuditEntry {
  actorType: 'admin' | 'user' | 'webhook' | 'cron' | 'system'
  actorId?: string
  event: string
  workspaceId?: string
  ip?: string
  userAgent?: string
  outcome: 'success' | 'failure' | 'denied'
  details?: Record<string, unknown>
}

/** Fire-and-forget; never throws. */
export async function audit(entry: AuditEntry): Promise<void> {
  void (async () => {
    await ensureDdl()
    try {
      await db.execute(sql`
        INSERT INTO r697_audit_log (id, actor_type, actor_id, event, workspace_id, ip, user_agent, outcome, details)
        VALUES (${`au_${crypto.randomBytes(8).toString('hex')}`}, ${entry.actorType}, ${entry.actorId ?? null},
                ${entry.event}, ${entry.workspaceId ?? null}, ${entry.ip ?? null}, ${entry.userAgent?.slice(0, 200) ?? null},
                ${entry.outcome}, ${entry.details ? JSON.stringify(entry.details) : null}::jsonb)
      `)
    } catch { /* tolerated */ }
  })()
}

export interface AuditQuery { event?: string; actorType?: string; actorId?: string; workspaceId?: string; since?: Date; limit?: number }

export async function queryAuditLog(q: AuditQuery): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  const limit = Math.max(1, Math.min(500, q.limit ?? 100))
  const conditions: string[] = []
  if (q.event)       conditions.push(`event = '${q.event.replace(/'/g, "''")}'`)
  if (q.actorType)   conditions.push(`actor_type = '${q.actorType.replace(/'/g, "''")}'`)
  if (q.actorId)     conditions.push(`actor_id = '${q.actorId.replace(/'/g, "''")}'`)
  if (q.workspaceId) conditions.push(`workspace_id = '${q.workspaceId.replace(/'/g, "''")}'`)
  if (q.since)       conditions.push(`ts >= '${q.since.toISOString()}'`)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  try {
    const rows = await db.execute(sql.raw(`
      SELECT id, ts, actor_type, actor_id, event, workspace_id, ip, outcome, details
      FROM r697_audit_log ${where}
      ORDER BY ts DESC LIMIT ${limit}
    `))
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}
