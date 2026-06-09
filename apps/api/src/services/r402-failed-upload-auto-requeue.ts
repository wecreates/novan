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

// R421 rate limiter — at most 1 LLM selector-improver call per (workspace,
// platform) per hour. Bounded by # of platforms × workspaces so memory OK.
const SELECTOR_IMPROVER_RL_WINDOW_MS = 60 * 60_000
const SELECTOR_IMPROVER_RL = new Map<string, number>()

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

    // R435 — strict: only requeue rows that actually have a failed_at
    // timestamp >2h ago. Rows without failed_at (i.e., didn't go through
    // R426 markFailed) shouldn't auto-requeue because we can't know when
    // they failed — operator must inspect them via queue.stuck instead.
    const rows = await db.execute(sql`
      SELECT id, workspace_id, platform, COALESCE(retry_count, 0) AS retry_count, failed_at, notes
      FROM design_upload_queue
      WHERE status = 'failed' AND failed_at IS NOT NULL AND failed_at < ${cutoff}
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
      // failure event for this platform. Rate-limited to 1 LLM call per
      // (workspace, platform) per hour to cap spend.
      const rlKey = `${r.workspace_id}|${r.platform}`
      const rlLast = SELECTOR_IMPROVER_RL.get(rlKey) ?? 0
      if (Date.now() - rlLast < SELECTOR_IMPROVER_RL_WINDOW_MS) continue
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
          SELECTOR_IMPROVER_RL.set(rlKey, Date.now())
          const { improveSelectors } = await import('./r366-selector-improver.js')
          try {
            const { recordSpend } = await import('./r428-ai-spend-tracker.js')
            await recordSpend(r.workspace_id, 'selector_improver', 1 /* ~$0.01 Claude call */)
          } catch { /* tolerated */ }
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
