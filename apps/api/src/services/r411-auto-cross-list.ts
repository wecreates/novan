/**
 * R411 — Auto-cross-list proven winners to missing platforms.
 *
 * For each top-revenue design with at least one sale, identify platforms
 * the design is NOT yet on (live/queued/failed), and enqueue it on those
 * with priority 75 (between fresh queue and winner-variants).
 *
 * Caps at MAX_WINNERS designs per run and MAX_PLATFORMS per design to avoid
 * burst-flagging risk. The R378 + R387 pacing layer enforces inter-upload
 * minimums afterward.
 *
 * Hourly tick.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const MAX_WINNERS = 3
const MAX_PLATFORMS_PER_DESIGN = 4
const MIN_USD_TO_CROSS_LIST = 1

export interface AutoCrossListResult {
  workspaces: number
  triggered:  Array<{ workspaceId: string; designId: string; prompt: string; addedPlatforms: string[] }>
  skipped:    number
}

export async function autoCrossListWinners(): Promise<AutoCrossListResult> {
  const out: AutoCrossListResult = { workspaces: 0, triggered: [], skipped: 0 }

  let workspaceIds: string[] = []
  try {
    const r = await db.execute(sql`SELECT DISTINCT workspace_id FROM design_upload_queue`)
    workspaceIds = (r as unknown as Array<{ workspace_id: string }>).map(x => x.workspace_id).filter(Boolean)
  } catch { /* tolerated */ }
  if (workspaceIds.length === 0) return out
  out.workspaces = workspaceIds.length

  const { rankDesignPerformance } = await import('./r395-design-performance.js')
  const { designPlatformCoverage } = await import('./r410-design-platform-coverage.js')
  const { enqueue } = await import('./r349-upload-queue.js')
  const { generateListingWithAttribution } = await import('./r349-listing-content-rotator.js')

  for (const ws of workspaceIds) {
    try {
      const perf = await rankDesignPerformance(ws, 10)
      const winners = perf.designs.filter(d => d.totalUsd >= MIN_USD_TO_CROSS_LIST).slice(0, MAX_WINNERS)
      if (winners.length === 0) continue
      const coverage = await designPlatformCoverage(ws, winners.map(w => w.designId))

      for (const cov of coverage) {
        const w = winners.find(x => x.designId === cov.designId)
        if (!w) continue
        const toAdd = cov.missing.slice(0, MAX_PLATFORMS_PER_DESIGN)
        if (toAdd.length === 0) { out.skipped++; continue }
        const niche = (await db.execute(sql`SELECT niche, style FROM design_catalog WHERE id = ${cov.designId} LIMIT 1`).catch(() => [] as unknown[])) as unknown as Array<{ niche: string; style: string }>
        const designNiche = niche[0]?.niche ?? 'botanical'
        const designStyle = niche[0]?.style ?? 'watercolor'
        const subject = w.prompt.split(',')[0]?.trim() ?? 'design'

        const added: string[] = []
        for (const platform of toAdd) {
          try {
            const listing = await generateListingWithAttribution({
              workspaceId: ws, platform: platform as 'gumroad',
              subject, niche: designNiche as 'botanical', style: designStyle as 'watercolor',
              designId: cov.designId,
            })
            const r = await enqueue({
              workspaceId: ws, designId: cov.designId, platform: platform as 'gumroad',
              title: listing.title, description: listing.description, tags: listing.tags,
              priceUsd: listing.priceUsd, priority: 75,
              ...(listing.category ? { category: listing.category } : {}),
              notes: `auto-cross-list winner ${w.totalUsd} usd`,
            })
            if (r.ok) added.push(platform)
          } catch { /* skip individual failures */ }
        }
        if (added.length > 0) {
          out.triggered.push({ workspaceId: ws, designId: cov.designId, prompt: w.prompt.slice(0, 60), addedPlatforms: added })
        }
      }
    } catch { /* tolerated */ }
  }
  return out
}
