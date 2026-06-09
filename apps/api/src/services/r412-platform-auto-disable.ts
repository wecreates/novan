/**
 * R412 — Auto-disable broken platforms.
 *
 * If a platform has ≥ FAILURE_THRESHOLD failures in the last 7d AND zero
 * uploads in that window, mark it disabled. Disabled platforms are skipped
 * by R411 cross-list, R382 pipeline platform-pool, and R381 variant
 * auto-queue. Operator gets a push notification.
 *
 * Persisted in disabled_platforms table. Operator manually re-enables via
 * platforms.enable brain-task op once fixed.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const FAILURE_THRESHOLD = 10
const WINDOW_MS = 7 * 24 * 60 * 60_000

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS disabled_platforms (
      workspace_id  TEXT NOT NULL,
      platform      TEXT NOT NULL,
      disabled_at   BIGINT NOT NULL,
      reason        TEXT,
      PRIMARY KEY (workspace_id, platform)
    )
  `).catch(() => {})
}

export interface DisableSweepResult {
  newlyDisabled: Array<{ workspaceId: string; platform: string; failures: number }>
  alreadyDisabled: number
}

export async function autoDisableBrokenPlatforms(): Promise<DisableSweepResult> {
  await ensureTable()
  const out: DisableSweepResult = { newlyDisabled: [], alreadyDisabled: 0 }
  const cutoff = Date.now() - WINDOW_MS

  const rows = await db.execute(sql`
    SELECT workspace_id, platform,
      COUNT(*) FILTER (WHERE status = 'failed' AND COALESCE(failed_at, queued_at) >= ${cutoff})::int AS failures,
      COUNT(*) FILTER (WHERE status = 'uploaded' AND uploaded_at >= ${cutoff})::int AS uploads
    FROM design_upload_queue
    GROUP BY workspace_id, platform
    HAVING COUNT(*) FILTER (WHERE status = 'failed' AND COALESCE(failed_at, queued_at) >= ${cutoff}) >= ${FAILURE_THRESHOLD}
       AND COUNT(*) FILTER (WHERE status = 'uploaded' AND uploaded_at >= ${cutoff}) = 0
  `).catch(() => [] as unknown[])

  const { broadcastPush } = await import('./web-push.js')

  for (const r of (rows as Array<{ workspace_id: string; platform: string; failures: number }>)) {
    const ex = await db.execute(sql`
      SELECT 1 FROM disabled_platforms WHERE workspace_id = ${r.workspace_id} AND platform = ${r.platform} LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(ex) && ex.length > 0) { out.alreadyDisabled++; continue }

    await db.execute(sql`
      INSERT INTO disabled_platforms (workspace_id, platform, disabled_at, reason)
      VALUES (${r.workspace_id}, ${r.platform}, ${Date.now()}, ${`${r.failures} failures / 0 success in 7d`})
      ON CONFLICT (workspace_id, platform) DO NOTHING
    `).catch(() => {/* best effort */})

    try {
      void broadcastPush(r.workspace_id, {
        title: `⚠ ${r.platform} auto-disabled`,
        body:  `${r.failures} failures, 0 success in 7d. Fix the driver, then run platforms.enable to re-enable.`,
        url:   '/ops/dashboard',
        tag:   `disabled-${r.platform}`,
      } as Parameters<typeof broadcastPush>[1])
    } catch { /* tolerated */ }

    out.newlyDisabled.push({ workspaceId: r.workspace_id, platform: r.platform, failures: Number(r.failures) })
  }
  return out
}

export async function isPlatformDisabled(workspaceId: string, platform: string): Promise<boolean> {
  try {
    const r = await db.execute(sql`
      SELECT 1 FROM disabled_platforms WHERE workspace_id = ${workspaceId} AND platform = ${platform} LIMIT 1
    `)
    return Array.isArray(r) && r.length > 0
  } catch { return false }
}

export async function enablePlatform(workspaceId: string, platform: string): Promise<{ ok: true }> {
  await db.execute(sql`
    DELETE FROM disabled_platforms WHERE workspace_id = ${workspaceId} AND platform = ${platform}
  `).catch(() => {/* best effort */})
  return { ok: true }
}

export async function listDisabledPlatforms(workspaceId: string): Promise<Array<{ platform: string; disabledAt: number; reason: string }>> {
  try {
    const r = await db.execute(sql`
      SELECT platform, disabled_at, reason FROM disabled_platforms WHERE workspace_id = ${workspaceId}
      ORDER BY disabled_at DESC
    `)
    return (r as Array<{ platform: string; disabled_at: number; reason: string }>).map(x => ({
      platform: x.platform, disabledAt: Number(x.disabled_at), reason: x.reason,
    }))
  } catch { return [] }
}
