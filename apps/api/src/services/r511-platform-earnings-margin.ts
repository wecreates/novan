/**
 * R511 + R512 — Per-platform earnings + margin calculator.
 *
 * Aggregates `business_revenue` by source so dashboard shows
 * "Gumroad $1,247 · Etsy $89 · INPRNT $34" instead of one MRR blob.
 *
 * Applies platform-specific fee schedules so operator sees NET-after-fees:
 *   - gumroad:     gross × 0.90 (10% Gumroad fee on digital goods)
 *   - etsy:        gross × 0.79 (6.5% transaction + 13% if EDP + listing fee approx)
 *   - inprnt:      net = gross × 0.30 (operator's commission of artist plan)
 *   - fine_art_america: gross × 0.30 (default commission)
 *   - redbubble:   gross × 0.20 (default base + markup)
 *   - tiktok_shop: gross × 0.85 (5% commission + payment)
 *   - displate:    gross × 0.20
 *   - teepublic:   gross × 0.20
 *   - threadless:  gross × 0.20
 *   - zazzle:      gross × 0.15
 *   - spreadshirt: gross × 0.15
 *
 * These are approximations — actual fee structures are tiered. Operator
 * can override per-source via workspace_settings.<source>_take_rate=0.X
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const DEFAULT_TAKE_RATE: Record<string, number> = {
  gumroad: 0.90, etsy: 0.79, inprnt: 0.30, fine_art_america: 0.30,
  redbubble: 0.20, tiktok_shop: 0.85, displate: 0.20,
  teepublic: 0.20, threadless: 0.20, zazzle: 0.15, spreadshirt: 0.15,
}

export interface PlatformEarnings {
  source:        string
  grossUsd:      number
  netUsd:        number       // gross × take rate
  saleCount:     number
  takeRate:      number
  marginUsd:     number       // net - estimated cost (image gen + opps)
}

export async function platformEarningsBreakdown(workspaceId: string, sinceMs = 0): Promise<{ items: PlatformEarnings[]; totalGross: number; totalNet: number }> {
  let items: PlatformEarnings[] = []
  let totalGross = 0, totalNet = 0
  try {
    const { getNumSetting } = await import('./r437-operator-timezone.js')
    const rows = await db.execute(sql`
      SELECT source,
             COUNT(*)::int AS sales,
             COALESCE(SUM(COALESCE(gross_usd, net_usd, 0)), 0)::float AS gross
      FROM business_revenue
      WHERE workspace_id = ${workspaceId} AND source IS NOT NULL AND recorded_at >= ${sinceMs}
      GROUP BY source ORDER BY gross DESC
    `)
    for (const r of (rows as unknown as Array<{ source: string; sales: number; gross: number }>)) {
      const overrideRate = await getNumSetting(workspaceId, `${r.source}_take_rate`, 0)
      const takeRate = overrideRate > 0 ? overrideRate : (DEFAULT_TAKE_RATE[r.source] ?? 0.50)
      const gross = Number(r.gross)
      const net = gross * takeRate
      totalGross += gross
      totalNet += net
      // R512 — margin estimate: subtract image gen attributable to this source
      // (rough — full proportional accounting would need design→source mapping)
      items.push({
        source: r.source, grossUsd: Math.round(gross * 100) / 100,
        netUsd: Math.round(net * 100) / 100, saleCount: Number(r.sales),
        takeRate, marginUsd: Math.round(net * 100) / 100,    // simplified — net = margin until we attribute costs
      })
    }
  } catch { /* tolerated */ }
  return { items, totalGross: Math.round(totalGross * 100) / 100, totalNet: Math.round(totalNet * 100) / 100 }
}
