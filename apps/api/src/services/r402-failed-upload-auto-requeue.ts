/**
 * R402 — Auto-requeue failed uploads.
 *
 * Items in status='failed' for >2h are eligible to be flipped back to
 * 'queued' so the agent's next pass retries them. The R366 selector
 * improver has time to suggest better selectors between attempts.
 *
 * Retry counter is bumped per attempt. After MAX_RETRIES, item stays
 * failed (operator manual review).
 *
 * Hourly tick.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const RETRY_AFTER_MS = 2 * 60 * 60_000
const MAX_RETRIES = 3

async function ensureColumn(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE design_upload_queue ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0
  `).catch(() => {})
  await db.execute(sql`
    ALTER TABLE design_upload_queue ADD COLUMN IF NOT EXISTS failed_at BIGINT
  `).catch(() => {})
}

export interface RequeueResult {
  requeued:    Array<{ id: string; platform: string; retryCount: number }>
  maxedOut:    number
  totalFailed: number
}

export async function requeueFailedUploads(): Promise<RequeueResult> {
  await ensureColumn()
  const result: RequeueResult = { requeued: [], maxedOut: 0, totalFailed: 0 }
  const cutoff = Date.now() - RETRY_AFTER_MS

  try {
    const countRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM design_upload_queue WHERE status = 'failed'
    `)
    result.totalFailed = Number((countRows as Array<{ n: number }>)[0]?.n ?? 0)

    const rows = await db.execute(sql`
      SELECT id, platform, COALESCE(retry_count, 0) AS retry_count, COALESCE(failed_at, queued_at) AS failed_at
      FROM design_upload_queue
      WHERE status = 'failed' AND COALESCE(failed_at, queued_at) < ${cutoff}
      LIMIT 50
    `)
    for (const r of (rows as Array<{ id: string; platform: string; retry_count: number; failed_at: number }>)) {
      const rc = Number(r.retry_count) || 0
      if (rc >= MAX_RETRIES) {
        result.maxedOut++
        continue
      }
      await db.execute(sql`
        UPDATE design_upload_queue
        SET status = 'queued',
            retry_count = ${rc + 1},
            failed_at = NULL
        WHERE id = ${r.id}
      `).catch(() => {/* skip on error */})
      result.requeued.push({ id: r.id, platform: r.platform, retryCount: rc + 1 })
    }
  } catch { /* tolerated */ }

  return result
}
