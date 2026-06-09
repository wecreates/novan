/**
 * R404 — Niche performance aggregator.
 *
 * Rolls up revenue + sale count + design count by niche. Operator sees
 * "botanical earned $X across N designs, vintage earned $Y across M" —
 * drives the next trend-pipeline focus toward proven niches.
 *
 * Computes "niche winner rate" = (designs with ≥1 sale) / (total designs).
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface NichePerformance {
  niche:             string
  designCount:       number
  winnerCount:       number   // designs with at least 1 sale
  winnerRate:        number   // 0-1
  totalUsd:          number
  saleCount:         number
  uploadCount:       number
}

export async function rankNichePerformance(workspaceId: string): Promise<{ niches: NichePerformance[]; total: NichePerformance | null }> {
  let niches: NichePerformance[] = []
  let total: NichePerformance | null = null
  try {
    const rows = await db.execute(sql`
      SELECT
        d.niche AS niche,
        COUNT(DISTINCT d.id)::int AS design_count,
        COUNT(DISTINCT CASE WHEN br.id IS NOT NULL THEN d.id END)::int AS winner_count,
        COUNT(DISTINCT duq.id) FILTER (WHERE duq.status = 'uploaded')::int AS upload_count,
        COUNT(br.id)::int AS sale_count,
        COALESCE(SUM(br.net_usd), 0)::float AS total_usd
      FROM design_catalog d
      LEFT JOIN design_upload_queue duq
             ON duq.design_id = d.id AND duq.workspace_id = ${workspaceId}
      LEFT JOIN business_revenue br
             ON br.workspace_id = ${workspaceId}
            AND br.metadata->>'permalink' = duq.external_url
      WHERE d.workspace_id = ${workspaceId}
      GROUP BY d.niche
      ORDER BY total_usd DESC, sale_count DESC, design_count DESC
    `)
    niches = (rows as Array<{ niche: string; design_count: number; winner_count: number; upload_count: number; sale_count: number; total_usd: number }>).map(r => {
      const dc = Number(r.design_count) || 0
      const wc = Number(r.winner_count) || 0
      return {
        niche:       r.niche,
        designCount: dc,
        winnerCount: wc,
        winnerRate:  dc > 0 ? Math.round((wc / dc) * 1000) / 1000 : 0,
        totalUsd:    Math.round(Number(r.total_usd) * 100) / 100,
        saleCount:   Number(r.sale_count) || 0,
        uploadCount: Number(r.upload_count) || 0,
      }
    })
    if (niches.length > 0) {
      total = {
        niche:       'ALL',
        designCount: niches.reduce((a, n) => a + n.designCount, 0),
        winnerCount: niches.reduce((a, n) => a + n.winnerCount, 0),
        winnerRate:  0,
        totalUsd:    Math.round(niches.reduce((a, n) => a + n.totalUsd, 0) * 100) / 100,
        saleCount:   niches.reduce((a, n) => a + n.saleCount, 0),
        uploadCount: niches.reduce((a, n) => a + n.uploadCount, 0),
      }
      total.winnerRate = total.designCount > 0 ? Math.round((total.winnerCount / total.designCount) * 1000) / 1000 : 0
    }
  } catch { /* tolerated */ }
  return { niches, total }
}
