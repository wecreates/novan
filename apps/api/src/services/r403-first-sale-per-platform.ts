/**
 * R403 — Per-platform first-sale milestone tracker.
 *
 * On every cron tick, looks at business_revenue rows. For each (workspace,
 * source) pair where this is the first ever sale, emits an event + sends
 * a push notification. Persists in platform_first_sale to dedupe across
 * runs.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS platform_first_sale (
      workspace_id  TEXT NOT NULL,
      platform      TEXT NOT NULL,
      first_sale_id TEXT NOT NULL,
      first_at      BIGINT NOT NULL,
      pushed        BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (workspace_id, platform)
    )
  `).catch(() => {})
}

export interface FirstSaleResult {
  detected: Array<{ workspaceId: string; platform: string; firstAt: number; pushed: boolean }>
  scanned:  number
}

export async function detectAndPushFirstSales(): Promise<FirstSaleResult> {
  await ensureTable()
  const out: FirstSaleResult = { detected: [], scanned: 0 }

  // For each (workspace, source) compute MIN(recorded_at). Insert if not present.
  let rows: Array<{ workspace_id: string; platform: string; min_ts: number; first_id: string }> = []
  try {
    const r = await db.execute(sql`
      SELECT DISTINCT ON (workspace_id, source)
        workspace_id, source AS platform,
        recorded_at AS min_ts, id AS first_id
      FROM business_revenue
      WHERE source IS NOT NULL
      ORDER BY workspace_id, source, recorded_at ASC
    `)
    rows = r as typeof rows
  } catch { /* tolerated */ }
  out.scanned = rows.length

  const { broadcastPush } = await import('./web-push.js')

  for (const r of rows) {
    const existing = await db.execute(sql`
      SELECT pushed FROM platform_first_sale
      WHERE workspace_id = ${r.workspace_id} AND platform = ${r.platform}
      LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(existing) && existing.length > 0) continue

    // First time we see this platform
    let pushed = false
    try {
      void broadcastPush(r.workspace_id, {
        title: `🎉 First sale on ${r.platform}`,
        body:  `Welcome to the ${r.platform} club. Variants of this design are auto-queued; watch the dashboard.`,
        url:   '/ops/dashboard',
        tag:   `first-sale-${r.platform}`,
      } as Parameters<typeof broadcastPush>[1])
      pushed = true
    } catch { /* tolerated */ }

    await db.execute(sql`
      INSERT INTO platform_first_sale (workspace_id, platform, first_sale_id, first_at, pushed)
      VALUES (${r.workspace_id}, ${r.platform}, ${r.first_id}, ${Number(r.min_ts)}, ${pushed})
      ON CONFLICT (workspace_id, platform) DO NOTHING
    `).catch(() => {/* best effort */})

    out.detected.push({ workspaceId: r.workspace_id, platform: r.platform, firstAt: Number(r.min_ts), pushed })
  }

  return out
}
