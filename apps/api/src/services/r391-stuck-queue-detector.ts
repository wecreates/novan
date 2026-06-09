/**
 * R391 — Stuck-queue detector.
 *
 * Items that have been in design_upload_queue.status='queued' for >48h with
 * no attempt are stuck. Usually means:
 *   - pacing keeps blocking them (R378)
 *   - their platform driver consistently fails (R388 should surface)
 *   - operator hasn't run pnpm daily
 *
 * Surfaces top stuck items so operator can decide: reprioritize, change
 * platform, or kill the queue item.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const STUCK_THRESHOLD_MS = 48 * 60 * 60_000

export interface StuckItem {
  id:          string
  platform:    string
  title:       string
  ageHours:    number
  priority:    number
  notes:       string | null
}

export async function detectStuckQueueItems(workspaceId: string, limit = 20): Promise<{ items: StuckItem[]; totalStuck: number; thresholdHours: number }> {
  const cutoff = Date.now() - STUCK_THRESHOLD_MS
  let totalStuck = 0
  let items: StuckItem[] = []
  try {
    const countRows = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM design_upload_queue
      WHERE workspace_id = ${workspaceId} AND status = 'queued' AND queued_at < ${cutoff}
    `)
    totalStuck = Number((countRows as Array<{ n: number }>)[0]?.n ?? 0)

    const rows = await db.execute(sql`
      SELECT id, platform, title, queued_at, priority, notes
      FROM design_upload_queue
      WHERE workspace_id = ${workspaceId} AND status = 'queued' AND queued_at < ${cutoff}
      ORDER BY priority DESC, queued_at ASC
      LIMIT ${limit}
    `)
    items = (rows as Array<{ id: string; platform: string; title: string; queued_at: number; priority: number; notes: string | null }>).map(r => ({
      id:       r.id,
      platform: r.platform,
      title:    r.title,
      ageHours: Math.round((Date.now() - Number(r.queued_at)) / 3_600_000),
      priority: Number(r.priority) || 50,
      notes:    r.notes,
    }))
  } catch { /* tolerated */ }
  return { items, totalStuck, thresholdHours: 48 }
}
