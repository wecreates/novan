/**
 * R417 — Zero-sale listing refresh.
 *
 * After RELIST_AGE_MS days live with 0 sales, re-enqueue with fresh listing
 * copy (different titleIdx from R380's outcome-tracker pool). Caps at
 * MAX_PER_RUN per workspace to avoid blasting.
 *
 * Daily-ish tick (gated to 15:00 UTC inside scheduleJittered handler).
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const RELIST_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_PER_RUN = 5
const RELIST_PRIORITY = 70

export interface RelistResult {
  scanned:   number
  relisted:  Array<{ workspaceId: string; designId: string; platform: string; oldTitle: string; newTitle: string }>
}

export async function relistZeroSaleListings(): Promise<RelistResult> {
  const out: RelistResult = { scanned: 0, relisted: [] }
  const cutoff = Date.now() - RELIST_AGE_MS

  // Listings that have been live >30d with no sale (no business_revenue row
  // joined by external_url match) AND haven't already been relisted recently.
  let candidates: Array<{ workspace_id: string; design_id: string; platform: string; title: string; external_url: string; prompt: string; niche: string; style: string }> = []
  try {
    const r = await db.execute(sql`
      SELECT duq.workspace_id, duq.design_id, duq.platform, duq.title, duq.external_url,
             d.prompt, d.niche, d.style
        FROM design_upload_queue duq
        JOIN design_catalog d ON d.id = duq.design_id
       WHERE duq.status = 'uploaded'
         AND duq.uploaded_at < ${cutoff}
         AND duq.external_url IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM business_revenue br
            WHERE br.workspace_id = duq.workspace_id
              AND br.metadata->>'permalink' = duq.external_url
         )
         AND NOT EXISTS (
           SELECT 1 FROM design_upload_queue duq2
            WHERE duq2.workspace_id = duq.workspace_id
              AND duq2.design_id = duq.design_id
              AND duq2.platform = duq.platform
              AND duq2.status = 'queued'
              AND duq2.notes LIKE 'relist%'
         )
       LIMIT 100
    `)
    candidates = r as unknown as typeof candidates
  } catch { /* tolerated */ }
  out.scanned = candidates.length

  if (candidates.length === 0) return out

  // Group by workspace, cap MAX_PER_RUN each
  const perWs = new Map<string, typeof candidates>()
  for (const c of candidates) {
    const arr = perWs.get(c.workspace_id) ?? []
    if (arr.length < MAX_PER_RUN) {
      arr.push(c)
      perWs.set(c.workspace_id, arr)
    }
  }

  const { generateListingWithAttribution } = await import('./r349-listing-content-rotator.js')
  const { enqueue } = await import('./r349-upload-queue.js')

  for (const [ws, items] of perWs) {
    for (const it of items) {
      try {
        const subject = it.prompt.split(',')[0]?.trim() ?? 'design'
        const listing = await generateListingWithAttribution({
          workspaceId: ws,
          platform:    it.platform as 'gumroad',
          subject,
          niche:       it.niche as 'botanical',
          style:       it.style as 'watercolor',
          designId:    it.design_id,
        })
        // Skip if regenerated to the same title as the existing one
        if (listing.title === it.title) continue
        const r = await enqueue({
          workspaceId: ws, designId: it.design_id, platform: it.platform as 'gumroad',
          title:       listing.title,
          description: listing.description,
          tags:        listing.tags,
          priceUsd:    listing.priceUsd,
          priority:    RELIST_PRIORITY,
          ...(listing.category ? { category: listing.category } : {}),
          notes:       `relist of ${it.design_id} on ${it.platform} (no sale in 30d)`,
        })
        if (r.ok) {
          out.relisted.push({
            workspaceId: ws, designId: it.design_id, platform: it.platform,
            oldTitle: it.title.slice(0, 60), newTitle: listing.title.slice(0, 60),
          })
        }
      } catch { /* skip individual failures */ }
    }
  }

  return out
}
