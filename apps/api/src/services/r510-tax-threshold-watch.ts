/**
 * R510 — 1099-K threshold watch.
 *
 * Gumroad sends 1099-K when gross sales >= $600/year (post-2024 IRS rule).
 * Other platforms have similar thresholds. Operator should know they're
 * approaching so they can prep records.
 *
 * Per-source thresholds:
 *   - gumroad / etsy / inprnt / faa / redbubble / displate / teepublic / threadless: $600
 *   - tiktok_shop: $5,000 (1099-K threshold for marketplace sellers, 2025)
 *   - zazzle / spreadshirt: $600
 *
 * Fires a web push when YTD gross from a source crosses:
 *   - 80% of threshold ($480 default) — "heads up, get your books ready"
 *   - 100% — "you will receive a 1099"
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const THRESHOLDS_USD: Record<string, number> = {
  gumroad: 600, etsy: 600, inprnt: 600, fine_art_america: 600,
  redbubble: 600, displate: 600, teepublic: 600, threadless: 600,
  zazzle: 600, spreadshirt: 600,
  tiktok_shop: 5000,
}

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS tax_threshold_notifications (
      workspace_id   TEXT NOT NULL,
      year           INTEGER NOT NULL,
      source         TEXT NOT NULL,
      bucket         TEXT NOT NULL,         -- '80pct' | '100pct'
      notified_at    BIGINT NOT NULL,
      ytd_at_notify  DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (workspace_id, year, source, bucket)
    )
  `).catch(() => {})
}

export interface TaxWatchResult {
  workspaces: number
  notified:   Array<{ workspaceId: string; source: string; bucket: string; ytdGross: number; threshold: number }>
}

export async function watchTaxThresholds(): Promise<TaxWatchResult> {
  await ensureTable()
  const out: TaxWatchResult = { workspaces: 0, notified: [] }
  const year = new Date().getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM business_revenue WHERE source IS NOT NULL`)
    workspaceIds = (r as unknown as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { return out }
  out.workspaces = workspaceIds.length

  const { broadcastPush } = await import('./web-push.js')

  for (const ws of workspaceIds) {
    // Sum gross_usd per source for the current year
    const rows = await db.execute(sql`
      SELECT source, COALESCE(SUM(COALESCE(gross_usd, net_usd, 0)), 0)::float AS ytd
      FROM business_revenue
      WHERE workspace_id = ${ws} AND recorded_at >= ${yearStart} AND source IS NOT NULL
      GROUP BY source
    `).catch(() => [] as unknown[])
    for (const r of (rows as unknown as Array<{ source: string; ytd: number }>)) {
      const threshold = THRESHOLDS_USD[r.source] ?? 600
      const ytd = Number(r.ytd) || 0
      const checks: Array<{ bucket: '80pct' | '100pct'; at: number }> = [
        { bucket: '80pct',  at: threshold * 0.8 },
        { bucket: '100pct', at: threshold },
      ]
      for (const c of checks) {
        if (ytd < c.at) continue
        // Already notified this year?
        const exists = await db.execute(sql`
          SELECT 1 FROM tax_threshold_notifications
          WHERE workspace_id = ${ws} AND year = ${year} AND source = ${r.source} AND bucket = ${c.bucket}
          LIMIT 1
        `).catch(() => [] as unknown[])
        if (Array.isArray(exists) && exists.length > 0) continue
        const title = c.bucket === '100pct'
          ? `📋 ${r.source}: $${ytd.toFixed(0)} YTD — 1099-K incoming`
          : `📋 ${r.source}: $${ytd.toFixed(0)} YTD (80% of $${threshold})`
        const body  = c.bucket === '100pct'
          ? `${r.source} will issue a 1099-K for ${year}. Make sure your records match — pnpm download CSV via /ops/export/revenue.csv.`
          : `Heads up: ${r.source} sales at $${ytd.toFixed(0)} of $${threshold} 1099 threshold. Start consolidating receipts.`
        try {
          void broadcastPush(ws, { title, body, url: '/ops/dashboard', tag: `tax-${r.source}-${c.bucket}` } as Parameters<typeof broadcastPush>[1])
        } catch { /* tolerated */ }
        await db.execute(sql`
          INSERT INTO tax_threshold_notifications (workspace_id, year, source, bucket, notified_at, ytd_at_notify)
          VALUES (${ws}, ${year}, ${r.source}, ${c.bucket}, ${Date.now()}, ${ytd})
          ON CONFLICT (workspace_id, year, source, bucket) DO NOTHING
        `).catch(() => {/* tolerated */})
        out.notified.push({ workspaceId: ws, source: r.source, bucket: c.bucket, ytdGross: ytd, threshold })
      }
    }
  }
  return out
}
