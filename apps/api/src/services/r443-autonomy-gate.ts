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

// R542 — bound the cache so a misbehaving caller can't drive unbounded
// Map growth. 200 workspaces is far past any realistic operator count;
// well above multi-tenant scale and still cheap.
const MAX_CACHE = 200
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
  } catch {
    // R500 — opt-in fail-closed. Default is fail-open (return true) because
    // operator's intent on first install is autonomy ON. Set NOVAN_AUTONOMY_FAIL_CLOSED=1
    // for production environments where DB unavailability should pause work.
    if (process.env['NOVAN_AUTONOMY_FAIL_CLOSED'] === '1') allowed = false
  }
  // R542 — evict oldest when above the bound. Map iteration order is
  // insertion order so first key is the oldest.
  if (CACHE.size >= MAX_CACHE) {
    const firstKey = CACHE.keys().next().value
    if (firstKey !== undefined) CACHE.delete(firstKey)
  }
  CACHE.set(workspaceId, { allowed, until: Date.now() + TTL_MS })
  return allowed
}
