/**
 * R506 — Session-validity probe.
 *
 * Sites silently log out the operator after N days. Local agent only finds
 * out when an upload fails. By then R412 may have wasted multiple attempts.
 *
 * This helper records the LAST KNOWN session-OK timestamp per (workspace,
 * platform) so dashboard can show "Etsy session 26 days old — likely
 * expiring." Operator can pre-emptively re-login.
 *
 * Local agent calls /api/v1/brain/task with op='session.touch' after every
 * successful upload (or explicit login-check pass). The platform_sessions
 * row gets bumped. Dashboard reads the age and warns when >25d.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_sessions (
      workspace_id   TEXT NOT NULL,
      platform       TEXT NOT NULL,
      last_ok_at     BIGINT NOT NULL,
      last_check_kind TEXT NOT NULL,        -- 'upload_success' | 'explicit_login_check'
      PRIMARY KEY (workspace_id, platform)
    )
  `).catch(() => {})
}

export async function touchSession(workspaceId: string, platform: string, kind: 'upload_success' | 'explicit_login_check'): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO platform_sessions (workspace_id, platform, last_ok_at, last_check_kind)
    VALUES (${workspaceId}, ${platform}, ${Date.now()}, ${kind})
    ON CONFLICT (workspace_id, platform) DO UPDATE
    SET last_ok_at = EXCLUDED.last_ok_at, last_check_kind = EXCLUDED.last_check_kind
  `).catch(() => {/* tolerated */})
}

export interface SessionAge {
  platform:       string
  lastOkAt:       number
  ageDays:        number
  kind:           string
  warningLevel:   'ok' | 'warn' | 'stale'   // warn at >20d, stale at >27d
}

export async function sessionAges(workspaceId: string): Promise<SessionAge[]> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT platform, last_ok_at, last_check_kind FROM platform_sessions
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_ok_at ASC
    `)
    const now = Date.now()
    return (r as unknown as Array<{ platform: string; last_ok_at: number; last_check_kind: string }>).map(x => {
      const ageDays = Math.floor((now - Number(x.last_ok_at)) / (24 * 60 * 60_000))
      return {
        platform: x.platform, lastOkAt: Number(x.last_ok_at),
        ageDays, kind: x.last_check_kind,
        warningLevel: ageDays >= 27 ? 'stale' : ageDays >= 20 ? 'warn' : 'ok',
      }
    })
  } catch { return [] }
}
