/**
 * R374 — Sales-driven variant generator.
 *
 * When a sale lands on a SKU, identify which design produced it and
 * auto-generate 3-5 variants (color-shifted, cropped, re-framed). Variants
 * land in design_catalog with parent_design_id set, then go through the
 * normal listing-rotator + upload-queue path. The system literally responds
 * to revenue by making more of what's already proven to convert.
 *
 * Triggered from sales.sync_gumroad after persisting new sales.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const VARIANT_PROMPTS: Array<{ type: 'color_shift' | 'crop' | 'reframe'; suffix: string }> = [
  { type: 'color_shift', suffix: 'in soft pastel tones, warm cream palette' },
  { type: 'color_shift', suffix: 'in moody muted earth tones, vintage sepia' },
  { type: 'color_shift', suffix: 'in cool sage and blush palette' },
  { type: 'crop',        suffix: 'tight crop on central detail, square aspect' },
  { type: 'reframe',     suffix: 'wider composition, more negative space, gallery framing' },
]

export interface GenerateWinnerVariantsInput {
  workspaceId:    string
  parentDesignId: string
  count?:         number                 // default 3
}

export interface GenerateWinnerVariantsResult {
  ok:               boolean
  parentDesignId:   string
  variantsCreated:  number
  variantDesignIds: string[]
  failed:           number
  reason?:          string
}

/**
 * Find the parent design's prompt + niche + style, then call generateBatch
 * with variant-suffixed prompts so the design factory creates new entries
 * with parent_design_id set.
 */
export async function generateWinnerVariants(input: GenerateWinnerVariantsInput): Promise<GenerateWinnerVariantsResult> {
  const count = Math.min(Math.max(input.count ?? 3, 1), VARIANT_PROMPTS.length)

  // Look up the parent
  const rows = await db.execute(sql`
    SELECT prompt, niche, style FROM design_catalog
    WHERE workspace_id = ${input.workspaceId} AND id = ${input.parentDesignId}
    LIMIT 1
  `)
  const r = (rows as Array<{ prompt: string; niche: string; style: string }>)[0]
  if (!r) {
    return { ok: false, parentDesignId: input.parentDesignId, variantsCreated: 0, variantDesignIds: [], failed: 0, reason: 'parent design not found' }
  }
  const parentPrompt = r.prompt
  const niche = r.niche
  const style = r.style

  // Build variant prompts
  const variantSubjects = VARIANT_PROMPTS.slice(0, count).map(v => `${parentPrompt}, ${v.suffix}`)

  // Call generateBatch from the design factory
  const { generateBatch } = await import('./r349-design-factory.js')
  const gen = await generateBatch({
    workspaceId: input.workspaceId,
    niche:       niche as 'botanical',
    subjects:    variantSubjects,
    style:       style as 'watercolor',
    parentDesignId: input.parentDesignId,
  } as Parameters<typeof generateBatch>[0] & { parentDesignId: string }).catch(e => ({ generated: [], failed: variantSubjects.map(s => ({ subject: s, error: (e as Error).message })) }))

  const variantDesignIds: string[] = gen.generated.map(d => d.id)

  // R381 — auto-queue variants on every platform the parent shipped on
  if (variantDesignIds.length > 0) {
    try {
      const platformRows = await db.execute(sql`
        SELECT DISTINCT platform FROM design_upload_queue
        WHERE workspace_id = ${input.workspaceId} AND design_id = ${input.parentDesignId}
      `).catch(() => [] as unknown[])
      const platforms = (platformRows as Array<{ platform: string }>).map(r => r.platform)
      if (platforms.length > 0) {
        const { generateListingWithAttribution } = await import('./r349-listing-content-rotator.js')
        const { enqueue } = await import('./r349-upload-queue.js')
        let queued = 0
        for (const designId of variantDesignIds) {
          for (const platform of platforms) {
            const designRow = (await db.execute(sql`
              SELECT prompt, style FROM design_catalog WHERE id = ${designId}
            `).catch(() => [] as unknown[])) as Array<{ prompt: string; style: string }>
            const subject = (designRow[0]?.prompt ?? '').split(',')[0]?.trim() ?? 'design'
            const style = designRow[0]?.style ?? 'watercolor'
            const listing = await generateListingWithAttribution({
              workspaceId: input.workspaceId,
              platform:    platform as 'gumroad',
              subject,
              niche:       niche as 'botanical',
              style:       style as 'watercolor',
              designId,
            })
            const enqRes = await enqueue({
              workspaceId: input.workspaceId,
              designId,
              platform:    platform as 'gumroad',
              title:       listing.title,
              description: listing.description,
              tags:        listing.tags,
              priceUsd:    listing.priceUsd,
              priority:    80,                          // winner variants jump the queue
              ...(listing.category ? { category: listing.category } : {}),
              notes:       `winner_variant parent=${input.parentDesignId} titleIdx=${listing.titleIdx}`,
            }).catch(() => ({ ok: false, reason: 'enqueue threw' } as { ok: boolean; reason?: string }))
            if (enqRes.ok) queued++
          }
        }
        console.log(`[r374] auto-queued ${queued} variant×platform pairs across ${platforms.length} platforms`)
      }
    } catch (e) {
      console.error('[r374] auto-queue failed:', (e as Error).message)
    }
  }

  return {
    ok: true,
    parentDesignId: input.parentDesignId,
    variantsCreated: variantDesignIds.length,
    variantDesignIds,
    failed: gen.failed.length,
  }
}

/**
 * Given a list of sale external_sale_ids, look up which design(s) produced
 * them and trigger variant generation for each. Idempotent: skips designs
 * that already have variants.
 */
export async function reactToNewSales(workspaceId: string, externalSaleIds: string[]): Promise<{ triggered: number; skipped: number; totalVariants: number }> {
  let triggered = 0, skipped = 0, totalVariants = 0
  if (externalSaleIds.length === 0) return { triggered, skipped, totalVariants }

  // Sales → design_id via the upload_queue.external_url match.
  // A Gumroad sale's product permalink matches the upload_queue.external_url
  // we recorded after upload.
  const saleRows = await db.execute(sql`
    SELECT br.metadata->>'permalink' AS permalink
    FROM business_revenue br
    WHERE br.workspace_id = ${workspaceId}
      AND br.external_sale_id = ANY(${sql.raw('ARRAY[' + externalSaleIds.map((_, i) => `$${i + 2}`).join(',') + ']')})
  `).catch(() => [] as unknown[])
  // The above raw-param approach is messy; do per-id queries instead for safety.
  const winningDesigns = new Set<string>()
  for (const saleId of externalSaleIds) {
    const r = await db.execute(sql`
      SELECT br.metadata->>'permalink' AS permalink
      FROM business_revenue br
      WHERE br.workspace_id = ${workspaceId} AND br.external_sale_id = ${saleId}
      LIMIT 1
    `).catch(() => [] as unknown[])
    const perma = (r as Array<{ permalink: string }>)[0]?.permalink
    if (!perma) continue
    // Find the queue item with that external_url
    const q = await db.execute(sql`
      SELECT design_id FROM design_upload_queue
      WHERE workspace_id = ${workspaceId} AND external_url = ${perma} AND status = 'uploaded'
      LIMIT 1
    `).catch(() => [] as unknown[])
    const designId = (q as Array<{ design_id: string }>)[0]?.design_id
    if (designId) winningDesigns.add(designId)
  }

  void saleRows  // unused but kept for future bulk-optimization

  for (const parentDesignId of winningDesigns) {
    // Skip if this design already has variants
    const existing = await db.execute(sql`
      SELECT 1 FROM design_catalog
      WHERE workspace_id = ${workspaceId} AND parent_design_id = ${parentDesignId}
      LIMIT 1
    `).catch(() => [] as unknown[])
    if (Array.isArray(existing) && existing.length > 0) { skipped++; continue }
    const r = await generateWinnerVariants({ workspaceId, parentDesignId, count: 3 })
    if (r.ok) { triggered++; totalVariants += r.variantsCreated }
  }

  return { triggered, skipped, totalVariants }
}
