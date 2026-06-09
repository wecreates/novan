/**
 * R410 — Design platform-coverage.
 *
 * For a given workspace, returns the per-design map of which platforms a
 * design is live on vs queued vs missing entirely. Surfaces cross-listing
 * gaps: "vintage_peony is on Gumroad but not yet on FAA / Etsy."
 *
 * Used by:
 *   - dashboard widget (top winners' platform coverage)
 *   - operator op for any design id
 *   - future R411 auto-cross-list trigger
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const ALL_PLATFORMS = [
  'gumroad', 'inprnt', 'fine_art_america', 'redbubble',
  'etsy', 'zazzle', 'spreadshirt', 'teepublic',
  'tiktok_shop', 'displate', 'threadless',
] as const

export interface DesignCoverage {
  designId:    string
  prompt:      string
  live:        string[]
  queued:      string[]
  failed:      string[]
  missing:     string[]
  coverage:    number  // 0-1 = live / ALL_PLATFORMS
}

export async function designPlatformCoverage(workspaceId: string, designIds?: string[]): Promise<DesignCoverage[]> {
  let designs: Array<{ id: string; prompt: string }> = []
  try {
    if (designIds && designIds.length > 0) {
      const rows = await db.execute(sql`
        SELECT id, prompt FROM design_catalog
        WHERE workspace_id = ${workspaceId} AND id = ANY(ARRAY[${sql.raw(designIds.map(d => `'${d.replace(/'/g, "''")}'`).join(','))}]::text[])
      `)
      designs = rows as unknown as typeof designs
    } else {
      // Default: top 10 by revenue (via R395)
      const { rankDesignPerformance } = await import('./r395-design-performance.js')
      const r = await rankDesignPerformance(workspaceId, 10)
      designs = r.designs.map(d => ({ id: d.designId, prompt: d.prompt }))
    }
  } catch { return [] }

  const out: DesignCoverage[] = []
  for (const d of designs) {
    try {
      const rows = await db.execute(sql`
        SELECT platform, status FROM design_upload_queue
        WHERE workspace_id = ${workspaceId} AND design_id = ${d.id}
      `)
      const live: string[] = [], queued: string[] = [], failed: string[] = []
      for (const r of (rows as unknown as Array<{ platform: string; status: string }>)) {
        if (r.status === 'uploaded') live.push(r.platform)
        else if (r.status === 'queued') queued.push(r.platform)
        else if (r.status === 'failed') failed.push(r.platform)
      }
      const seen = new Set([...live, ...queued, ...failed])
      const missing = ALL_PLATFORMS.filter(p => !seen.has(p))
      out.push({
        designId: d.id,
        prompt:   String(d.prompt).slice(0, 80),
        live, queued, failed, missing,
        coverage: Math.round((live.length / ALL_PLATFORMS.length) * 100) / 100,
      })
    } catch { /* skip */ }
  }
  return out
}
