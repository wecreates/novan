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
    result.totalFailed = Number((countRows as unknown as Array<{ n: number }>)[0]?.n ?? 0)

    const rows = await db.execute(sql`
      SELECT id, workspace_id, platform, COALESCE(retry_count, 0) AS retry_count, COALESCE(failed_at, queued_at) AS failed_at, notes
      FROM design_upload_queue
      WHERE status = 'failed' AND COALESCE(failed_at, queued_at) < ${cutoff}
      LIMIT 50
    `)
    for (const r of (rows as unknown as Array<{ id: string; workspace_id: string; platform: string; retry_count: number; failed_at: number; notes: string | null }>)) {
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

      // R421 — auto-trigger R366 selector improver from the most recent
      // failure event for this platform. The next agent attempt will pull
      // stored selectors via resilientLocate.
      try {
        const failureEvent = await db.execute(sql`
          SELECT payload FROM events
          WHERE workspace_id = ${r.workspace_id}
            AND type IN ('agent.failure', 'agent.upload.failed')
            AND payload->>'platform' = ${r.platform}
          ORDER BY created_at DESC LIMIT 1
        `).catch(() => [] as unknown[])
        const ev = (failureEvent as unknown as Array<{ payload: Record<string, unknown> }>)[0]?.payload
        if (ev && ev['pageHtml'] && ev['errorMessage']) {
          const { improveSelectors } = await import('./r366-selector-improver.js')
          void improveSelectors({
            workspaceId:      r.workspace_id,
            platform:         r.platform,
            step:             String(ev['step'] ?? 'unknown'),
            errorMessage:     String(ev['errorMessage']),
            pageUrl:          String(ev['pageUrl'] ?? ''),
            pageHtmlExcerpt:  String(ev['pageHtml']).slice(0, 8192),
            ...(ev['previousSelectors'] ? { previousSelectors: ev['previousSelectors'] as string[] } : {}),
          })
        }
      } catch { /* tolerated — best-effort enhancement */ }
    }
  } catch { /* tolerated */ }

  return result
}
