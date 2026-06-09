/**
 * R400 — Auto-replenish queue when low.
 *
 * Hourly tick. If a workspace's queued-count drops below LOW_THRESHOLD,
 * trigger the trend pipeline immediately (don't wait for the 13:00 UTC
 * R382 cron). Prevents queue starvation when operator drains aggressively.
 *
 * Idempotency: respects R382's daily_cron_runs row by setting force=false
 * unless the queue is critically low (<10). At critical-low we force regen
 * because operator's pipeline is empty and that's actionable.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const LOW_THRESHOLD = 30
const CRITICAL_THRESHOLD = 10

export interface ReplenishResult {
  workspaces:    number
  replenished:   Array<{ workspaceId: string; queued: number; generated: number; queuedItems: number; forced: boolean }>
  skipped:       Array<{ workspaceId: string; queued: number; reason: string }>
}

export async function autoReplenishLowQueues(): Promise<ReplenishResult> {
  const result: ReplenishResult = { workspaces: 0, replenished: [], skipped: [] }

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as unknown as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { /* tolerated */ }
  if (workspaceIds.length === 0) return result
  result.workspaces = workspaceIds.length

  for (const ws of workspaceIds) {
    try {
      const r = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM design_upload_queue
        WHERE workspace_id = ${ws} AND status = 'queued'
      `)
      const queued = Number((r as unknown as Array<{ n: number }>)[0]?.n ?? 0)
      if (queued >= LOW_THRESHOLD) {
        result.skipped.push({ workspaceId: ws, queued, reason: `queued ${queued} >= ${LOW_THRESHOLD}` })
        continue
      }
      const forced = queued < CRITICAL_THRESHOLD
      const { runDailyCron } = await import('./r382-droplet-daily-cron.js')
      const dc = await runDailyCron(ws, { force: forced })
      if (dc.alreadyRanToday && !forced) {
        result.skipped.push({ workspaceId: ws, queued, reason: 'already ran today (not critical)' })
        continue
      }
      result.replenished.push({
        workspaceId:  ws,
        queued,
        generated:    dc.pipelineGenerated,
        queuedItems:  dc.pipelineQueued,
        forced,
      })
    } catch (e) {
      result.skipped.push({ workspaceId: ws, queued: -1, reason: (e as Error).message.slice(0, 100) })
    }
  }
  return result
}
