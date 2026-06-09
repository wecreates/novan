/**
 * R437 — Per-workspace operator timezone.
 *
 * Stores the operator's preferred timezone (IANA name, e.g. "America/Chicago")
 * so daily / weekly / morning crons can fire at the operator's local 8am
 * instead of hard 14:00 UTC. Falls back to UTC when unset.
 *
 * Persisted in workspace_settings (key='timezone'). Used by R398 / R413 / R417 / R382.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS workspace_settings (
      workspace_id  TEXT NOT NULL,
      key           TEXT NOT NULL,
      value         TEXT NOT NULL,
      updated_at    BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    )
  `).catch(() => {})
}

export async function getOperatorTimezone(workspaceId: string): Promise<string> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT value FROM workspace_settings WHERE workspace_id = ${workspaceId} AND key = 'timezone' LIMIT 1
    `)
    const v = (r as unknown as Array<{ value: string }>)[0]?.value
    if (v && typeof v === 'string') return v
  } catch { /* tolerated */ }
  return 'UTC'
}

export async function setOperatorTimezone(workspaceId: string, tz: string): Promise<{ ok: boolean }> {
  await ensureTable()
  // Validate via Intl.DateTimeFormat
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date()) }
  catch { return { ok: false } }
  await db.execute(sql`
    INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
    VALUES (${workspaceId}, 'timezone', ${tz}, ${Date.now()})
    ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `).catch(() => {/* best effort */})
  return { ok: true }
}

/** Returns the local hour (0-23) in the operator's timezone right now. */
export async function getOperatorLocalHour(workspaceId: string): Promise<number> {
  const tz = await getOperatorTimezone(workspaceId)
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())
    const h = parseInt(s, 10)
    if (Number.isFinite(h)) return ((h % 24) + 24) % 24
  } catch { /* fallback */ }
  return new Date().getUTCHours()
}

/** Returns the local ISO day-of-week (1=Mon..7=Sun) in operator's tz. */
export async function getOperatorLocalDay(workspaceId: string): Promise<number> {
  const tz = await getOperatorTimezone(workspaceId)
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date())
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
    return map[s] ?? (new Date().getUTCDay() || 7)
  } catch { return new Date().getUTCDay() || 7 }
}
