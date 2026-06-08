/**
 * R146.346 — Gumroad Product Publisher (autonomous)
 *
 * Orchestrates: source-image → upload-to-storage → create-product → publish.
 * No browser. No operator clicks during execution. Pure API.
 *
 * Caller: brain-task op pod.gumroad.publish_first_three (R346).
 *
 * For images Novan has already generated (image_generations table),
 * we use the storage URL directly. For the "vintage_map" placeholder,
 * we trigger a fresh image.generate via the existing image-generator
 * service.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { whoami, createProduct, publishProduct, FIRST_THREE_LISTINGS, type CreateProductInput } from './r346-gumroad-api.js'

export interface PublishStepResult {
  slot:        'audubon_woodpecker' | 'vintage_botanical_iris' | 'vintage_map'
  status:      'ok' | 'skipped' | 'failed'
  productId?:  string
  shortUrl?:   string
  editUrl?:    string
  reason?:     string
}

export interface PublishAllResult {
  whoami:    { user_id: string; name: string; email: string; url: string }
  steps:     PublishStepResult[]
  liveUrls:  string[]
}

async function findExistingImageUrl(workspaceId: string, niche: string): Promise<string | null> {
  try {
    // Look for a recent successful generation matching the niche
    const rows = await db.execute(sql`
      SELECT image_url FROM image_generations
      WHERE workspace_id = ${workspaceId}
        AND status = 'succeeded'
        AND prompt ILIKE ${'%' + niche + '%'}
      ORDER BY created_at DESC
      LIMIT 1
    `) as unknown as Array<{ image_url: string }>
    return rows[0]?.image_url ?? null
  } catch {
    return null
  }
}

async function generateMissing(workspaceId: string, prompt: string): Promise<string | null> {
  try {
    const { generateImage } = await import('./image-generator.js')
    const r = await generateImage({
      workspaceId, provider: 'huggingface',
      prompt,
      negativePrompt: 'text, watermark, signature, blurry, low quality, modern, photograph',
      width:  1024, height: 1024,
      budgetCapUsd: 0.01,
      createdBy: 'r346-gumroad-publisher',
    })
    return r.status === 'succeeded' ? (r.imageUrl ?? null) : null
  } catch {
    return null
  }
}

export async function publishFirstThree(input: {
  workspaceId:        string
  dryRun?:            boolean      // create products but don't publish
  skipIfNamedExists?: boolean       // don't recreate if product with same name exists
}): Promise<PublishAllResult> {
  const me = await whoami()
  const steps: PublishStepResult[] = []
  const liveUrls: string[] = []

  // Optional: check for existing products to avoid duplicates
  const existingNames = new Set<string>()
  if (input.skipIfNamedExists) {
    try {
      const { listProducts } = await import('./r346-gumroad-api.js')
      const existing = await listProducts()
      for (const p of existing) existingNames.add(p.name)
    } catch { /* ignore */ }
  }

  // Niche → slot mapping
  type Slot = 'audubon_woodpecker' | 'vintage_botanical_iris' | 'vintage_map'
  const SLOTS: Array<{
    key: Slot
    nicheKeyword: string                                  // for finding existing image
    fallbackPrompt: string                                 // for generating if missing
  }> = [
    { key: 'audubon_woodpecker',     nicheKeyword: 'woodpecker',
      fallbackPrompt: 'vintage natural history illustration of two ivory-billed woodpeckers perched on a magnolia branch, soft hand-colored watercolor on cream paper, museum quality, gallery wall print, after Audubon, fine detail' },
    { key: 'vintage_botanical_iris', nicheKeyword: 'iris',
      fallbackPrompt: 'vintage botanical illustration of an iris flower, fine art print, gallery quality, cream paper, soft hand-colored, museum collection style' },
    { key: 'vintage_map',            nicheKeyword: 'map',
      fallbackPrompt: 'decorative vintage map illustration in the style of 17th-18th century cartography, antique parchment, sepia and burnt orange tones, ornamental compass rose, fine engraving lines, museum quality' },
  ]

  for (const slot of SLOTS) {
    const template = FIRST_THREE_LISTINGS[slot.key]
    if (input.skipIfNamedExists && existingNames.has(template.name)) {
      steps.push({ slot: slot.key, status: 'skipped', reason: 'product with same name already exists' })
      continue
    }

    // 1) Find or generate the image
    let imageUrl: string | null = template.contentUrl ?? null
    if (!imageUrl) {
      imageUrl = await findExistingImageUrl(input.workspaceId, slot.nicheKeyword)
      if (!imageUrl) imageUrl = await generateMissing(input.workspaceId, slot.fallbackPrompt)
    }
    if (!imageUrl) {
      steps.push({ slot: slot.key, status: 'failed', reason: 'no image available and generation failed (provider may be unhealthy)' })
      continue
    }

    // 2) Create the product
    const payload: CreateProductInput = { ...template, contentUrl: imageUrl }
    try {
      const created = await createProduct(payload)
      let published = created.published
      if (!input.dryRun && !published) {
        try { published = await publishProduct(created.id) } catch { /* leave unpublished */ }
      }
      steps.push({
        slot:      slot.key,
        status:    'ok',
        productId: created.id,
        shortUrl:  created.short_url,
        editUrl:   created.edit_url,
        ...(published ? {} : { reason: 'created but not published — operator can review then enable' }),
      })
      if (published && created.short_url) liveUrls.push(created.short_url)
    } catch (e) {
      steps.push({ slot: slot.key, status: 'failed', reason: (e as Error).message.slice(0, 300) })
    }
  }

  return { whoami: me, steps, liveUrls }
}
