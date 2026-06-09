/**
 * R378 — Persistent inter-upload pacing.
 *
 * The local agent's pickInterUploadDelayMs picks 5-30 min jitter between
 * uploads, but only within a single `pnpm once` run. If the operator runs
 * pnpm once → 2 min later runs it again, the agent rushes through every
 * platform back-to-back. That's the anti-flag pattern we built the system
 * to avoid.
 *
 * This service persists per-platform "last upload" timestamps server-side.
 * Agent calls pacing.check_or_acquire before each platform attempt. If
 * upload happened too recently, the response says skip with retry-after.
 *
 * Inter-upload windows per platform are tunable but default to anti-flag
 * doctrine:
 *   - Most platforms: min 8 min between uploads (5-30 jitter avg ~17min)
 *   - TikTok Shop:    min 30 min (strictest fraud surface)
 *   - Pinterest:      ignored here; pin queue has its own cap
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS upload_pacing (
      workspace_id    TEXT NOT NULL,
      platform        TEXT NOT NULL,
      last_upload_at  BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, platform)
    )
  `).catch(() => {})
}

const MIN_INTERVAL_MS: Record<string, number> = {
  gumroad:           8  * 60_000,
  inprnt:            10 * 60_000,
  fine_art_america:  10 * 60_000,
  redbubble:         8  * 60_000,
  etsy:              12 * 60_000,           // Etsy is stricter
  zazzle:            10 * 60_000,
  spreadshirt:       10 * 60_000,
  teepublic:         10 * 60_000,
  tiktok_shop:       30 * 60_000,           // R350 — strictest fraud surface
  displate:          15 * 60_000,
  threadless:        10 * 60_000,
}

const DEFAULT_INTERVAL_MS = 10 * 60_000

export interface CheckOrAcquireInput {
  workspaceId: string
  platform:    string
  acquire?:    boolean                       // default true: also bumps the timestamp
}

export interface CheckOrAcquireResult {
  allowed:        boolean
  msSinceLast:    number | null
  minIntervalMs:  number
  retryAfterMs:   number                    // 0 if allowed
}

export async function checkOrAcquire(input: CheckOrAcquireInput): Promise<CheckOrAcquireResult> {
  await ensureTable()
  const min = MIN_INTERVAL_MS[input.platform] ?? DEFAULT_INTERVAL_MS
  const rows = await db.execute(sql`
    SELECT last_upload_at FROM upload_pacing
    WHERE workspace_id = ${input.workspaceId} AND platform = ${input.platform}
    LIMIT 1
  `).catch(() => [] as unknown[])
  const last = Number((rows as Array<{ last_upload_at: number }>)[0]?.last_upload_at ?? 0)
  const now = Date.now()
  const msSinceLast = last > 0 ? now - last : null

  if (last > 0 && (now - last) < min) {
    return {
      allowed:       false,
      msSinceLast,
      minIntervalMs: min,
      retryAfterMs:  min - (now - last),
    }
  }

  if (input.acquire !== false) {
    await db.execute(sql`
      INSERT INTO upload_pacing (workspace_id, platform, last_upload_at)
      VALUES (${input.workspaceId}, ${input.platform}, ${now})
      ON CONFLICT (workspace_id, platform)
      DO UPDATE SET last_upload_at = ${now}
    `).catch(() => {/* best effort */})
  }

  return {
    allowed:       true,
    msSinceLast,
    minIntervalMs: min,
    retryAfterMs:  0,
  }
}

export async function pacingSnapshot(workspaceId: string): Promise<Array<{ platform: string; lastUploadAgoMin: number; nextOkInMin: number }>> {
  await ensureTable()
  const rows = await db.execute(sql`
    SELECT platform, last_upload_at FROM upload_pacing
    WHERE workspace_id = ${workspaceId}
    ORDER BY last_upload_at DESC
  `).catch(() => [] as unknown[])
  const now = Date.now()
  return (rows as Array<{ platform: string; last_upload_at: number }>).map(r => {
    const last = Number(r.last_upload_at) || 0
    const min = MIN_INTERVAL_MS[r.platform] ?? DEFAULT_INTERVAL_MS
    return {
      platform:          r.platform,
      lastUploadAgoMin:  Math.round((now - last) / 60_000),
      nextOkInMin:       Math.max(0, Math.round((min - (now - last)) / 60_000)),
    }
  })
}
