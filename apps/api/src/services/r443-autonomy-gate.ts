/**
 * R443 — Autonomy gate helper.
 *
 * Single source of truth for "should this autonomous cron actually run?"
 * Returns false when the operator has flipped kill_switches.autonomous_writes
 * to enabled=false (= switch ENGAGED). Used by R382/R401/R411 to bail before
 * burning AI/queue work.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const CACHE = new Map<string, { allowed: boolean; until: number }>()
const TTL_MS = 30_000

/** R485 — operator can call this after engaging/disengaging the switch so
 *  the 30s autonomy-gate cache doesn't stay stale. */
export function invalidateAutonomyCache(workspaceId?: string): void {
  if (workspaceId) CACHE.delete(workspaceId); else CACHE.clear()
}

export async function isAutonomyAllowed(workspaceId: string): Promise<boolean> {
  const c = CACHE.get(workspaceId)
  if (c && c.until > Date.now()) return c.allowed
  let allowed = true
  try {
    const rows = await db.execute(sql`
      SELECT 1 FROM kill_switches
      WHERE workspace_id = ${workspaceId}
        AND switch_type = 'autonomous_writes'
        AND enabled = false
      LIMIT 1
    `)
    const r = rows as unknown as { rows?: unknown[] } | unknown[]
    const arr = Array.isArray(r) ? r : (r.rows ?? [])
    if (arr.length > 0) allowed = false
  } catch { /* tolerated — allow on error */ }
  CACHE.set(workspaceId, { allowed, until: Date.now() + TTL_MS })
  return allowed
}
