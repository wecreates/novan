/**
 * R395 — Design performance ranker.
 *
 * Joins business_revenue ↔ design_upload_queue.external_url to find which
 * design generated each sale. Computes $/day-since-first-upload per design.
 * Surfaces top 10 winners so operator (or R374) can lean into them.
 *
 * Also computes a "winner score" combining recency-weighted revenue + sale
 * count, so a single-$50-sale design ranks above 50× $1 micro-sales.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface DesignPerformance {
  designId:           string
  prompt:             string
  niche:              string
  totalUsd:           number
  saleCount:          number
  firstUploadedAt:    number
  daysLive:           number
  usdPerDay:          number
  hasVariants:        boolean
  winnerScore:        number     // higher = more likely a winner
}

// R480 — 60s memo so R401/R411 hourly ticks don't issue identical queries.
const RANK_CACHE = new Map<string, { ts: number; result: { designs: DesignPerformance[]; totalRevenue: number; totalSales: number } }>()
const RANK_TTL_MS = 60_000

export async function rankDesignPerformance(workspaceId: string, limit = 10): Promise<{ designs: DesignPerformance[]; totalRevenue: number; totalSales: number }> {
  const key = `${workspaceId}|${limit}`
  const c = RANK_CACHE.get(key)
  if (c && Date.now() - c.ts < RANK_TTL_MS) return c.result
  const r = await _rankDesignPerformance(workspaceId, limit)
  RANK_CACHE.set(key, { ts: Date.now(), result: r })
  return r
}

async function _rankDesignPerformance(workspaceId: string, limit = 10): Promise<{ designs: DesignPerformance[]; totalRevenue: number; totalSales: number }> {
  let totalRevenue = 0, totalSales = 0
  let designs: DesignPerformance[] = []
  try {
    const rows = await db.execute(sql`
      SELECT d.id                  AS design_id,
             d.prompt              AS prompt,
             d.niche               AS niche,
             COALESCE(SUM(br.net_usd), 0)::float AS total_usd,
             COUNT(br.id)::int    AS sale_count,
             MIN(duq.uploaded_at)::bigint AS first_uploaded_at,
             EXISTS (SELECT 1 FROM design_catalog dc2 WHERE dc2.parent_design_id = d.id) AS has_variants
        FROM design_catalog d
        JOIN design_upload_queue duq ON duq.design_id = d.id AND duq.workspace_id = ${workspaceId} AND duq.status = 'uploaded'
        LEFT JOIN business_revenue br
               ON br.workspace_id = ${workspaceId}
              AND br.metadata->>'permalink' = duq.external_url
       WHERE d.workspace_id = ${workspaceId}
       GROUP BY d.id, d.prompt, d.niche
      HAVING COALESCE(SUM(br.net_usd), 0) > 0
       ORDER BY total_usd DESC
       LIMIT ${limit}
    `)
    const now = Date.now()
    designs = (rows as Array<{ design_id: string; prompt: string; niche: string; total_usd: number; sale_count: number; first_uploaded_at: number; has_variants: boolean }>).map(r => {
      const firstUp = Number(r.first_uploaded_at) || now
      const daysLive = Math.max(1, Math.round((now - firstUp) / (24 * 60 * 60_000)))
      const usdPerDay = Number(r.total_usd) / daysLive
      // Winner score: usd/day weighted by recency (newer wins compound faster)
      const recencyBoost = Math.max(0.5, 1 - daysLive / 60)
      const winnerScore = Math.round((usdPerDay * 10 + Number(r.sale_count)) * recencyBoost * 100) / 100
      totalRevenue += Number(r.total_usd)
      totalSales += Number(r.sale_count)
      return {
        designId:        r.design_id,
        prompt:          String(r.prompt).slice(0, 100),
        niche:           String(r.niche),
        totalUsd:        Math.round(Number(r.total_usd) * 100) / 100,
        saleCount:       Number(r.sale_count),
        firstUploadedAt: firstUp,
        daysLive,
        usdPerDay:       Math.round(usdPerDay * 100) / 100,
        hasVariants:     Boolean(r.has_variants),
        winnerScore,
      }
    })
  } catch { /* tolerated */ }
  return { designs, totalRevenue: Math.round(totalRevenue * 100) / 100, totalSales }
}
