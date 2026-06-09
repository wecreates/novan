/**
 * R386 — Next-action push notifier.
 *
 * On a 15-minute cron tick, compares the current top next-action against the
 * last-pushed one (persisted in next_action_pushes). If it changed AND has
 * score >= 60, send a Web Push to every subscribed device for that workspace.
 * Wakes the operator only when something materially shifts.
 *
 * Dedup window: 4 hours. The same action will not re-fire within that window
 * even if score climbs.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const PUSH_MIN_SCORE = 60
const DEDUP_WINDOW_MS = 4 * 60 * 60_000   // 4h

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS next_action_pushes (
      workspace_id  TEXT NOT NULL,
      action_id     TEXT NOT NULL,
      pushed_at     BIGINT NOT NULL,
      score         INTEGER NOT NULL,
      title         TEXT NOT NULL,
      PRIMARY KEY (workspace_id, action_id, pushed_at)
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS next_action_pushes_ws_pushed_idx
    ON next_action_pushes (workspace_id, pushed_at DESC)
  `).catch(() => {})
}

export interface NextActionPushResult {
  workspaces: number
  pushed:     number
  skipped:    Array<{ workspaceId: string; reason: string }>
}

export async function pushNextActions(): Promise<NextActionPushResult> {
  await ensureTable()
  const result: NextActionPushResult = { workspaces: 0, pushed: 0, skipped: [] }

  // List workspaces
  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT workspace_id FROM design_upload_queue
      UNION SELECT DISTINCT workspace_id FROM business_revenue
    `)
    workspaceIds = (r as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { workspaceIds = ['default'] }
  if (workspaceIds.length === 0) workspaceIds = ['default']

  const { nextActions } = await import('./r385-next-action-recommender.js')
  const { broadcastPush } = await import('./web-push.js')

  for (const ws of workspaceIds) {
    result.workspaces++
    try {
      const r = await nextActions(ws)
      const top = r.actions[0]
      if (!top) { result.skipped.push({ workspaceId: ws, reason: 'no actions' }); continue }
      if (top.score < PUSH_MIN_SCORE) {
        result.skipped.push({ workspaceId: ws, reason: `score ${top.score} < ${PUSH_MIN_SCORE}` })
        continue
      }
      // Dedup: have we pushed this action_id within DEDUP_WINDOW_MS?
      const cutoff = Date.now() - DEDUP_WINDOW_MS
      const dupRows = await db.execute(sql`
        SELECT 1 FROM next_action_pushes
        WHERE workspace_id = ${ws} AND action_id = ${top.id} AND pushed_at >= ${cutoff}
        LIMIT 1
      `)
      if (Array.isArray(dupRows) && dupRows.length > 0) {
        result.skipped.push({ workspaceId: ws, reason: 'dedup window' })
        continue
      }
      // Push
      const send = await broadcastPush(ws, {
        title:  `Novan · ${top.title}`,
        body:   top.detail.slice(0, 180),
        url:    '/ops/dashboard',
        tag:    `next-action-${top.id}`,
      } as Parameters<typeof broadcastPush>[1])
      void send
      // Persist
      await db.execute(sql`
        INSERT INTO next_action_pushes (workspace_id, action_id, pushed_at, score, title)
        VALUES (${ws}, ${top.id}, ${Date.now()}, ${top.score}, ${top.title.slice(0, 200)})
      `).catch(() => {})
      result.pushed++
    } catch (e) {
      result.skipped.push({ workspaceId: ws, reason: (e as Error).message.slice(0, 100) })
    }
  }
  return result
}
