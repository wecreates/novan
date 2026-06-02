/**
 * image-upgrades.ts — R146.93 — image system gaps:
 *  multi-provider router, character consistency plan,
 *  upscale + face-fix plan, style-pack metadata,
 *  auto-variation testing, mockup compositor plan.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, desc, eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type ImageProvider = 'openai' | 'replicate-flux' | 'replicate-sdxl' | 'stability' | 'gemini-imagen' | 'pollinations'
export type ImageStyle = 'photoreal' | 'art' | 'illustration' | 'product' | 'character' | 'logo'

// ─── Multi-provider router (style → provider mapping) ────────────────────

/** R146.104 — Pollinations.ai added as zero-cost free-tier option. Auto-selected
 *  when (a) operator explicitly sets budgetUsd=0, or (b) no paid keys are
 *  present in env. Pollinations serves Flux-class outputs via public GET. */
function hasAnyPaidImageKey(): boolean {
  return Boolean(
    process.env['REPLICATE_API_TOKEN'] ||
    process.env['OPENAI_API_KEY'] ||
    process.env['STABILITY_API_KEY'] ||
    process.env['GEMINI_API_KEY']
  )
}

export function routeImageRequest(input: { style: ImageStyle; needsCharacterRef?: boolean; needsHighResolution?: boolean; budgetUsd?: number }): {
  primary: ImageProvider
  fallbacks: ImageProvider[]
  rationale: string
} {
  // R146.104 — free-tier shortcut: budgetUsd===0 or no paid keys → Pollinations first.
  if (input.budgetUsd === 0 || !hasAnyPaidImageKey()) {
    return {
      primary:   'pollinations',
      fallbacks: ['gemini-imagen', 'replicate-flux'],
      rationale: input.budgetUsd === 0
        ? 'budgetUsd=0 → Pollinations (free, no key)'
        : 'no paid image keys present → Pollinations (free, no key)',
    }
  }
  let primary: ImageProvider = 'replicate-flux'
  const fallbacks: ImageProvider[] = []
  let rationale = ''
  if (input.needsCharacterRef) {
    primary = 'replicate-flux'
    fallbacks.push('replicate-sdxl')
    rationale = 'character-ref conditioning via Flux + IP-Adapter'
  } else if (input.style === 'photoreal') {
    primary = 'replicate-flux'
    fallbacks.push('stability', 'openai')
    rationale = 'Flux Pro outperforms competitors on photoreal as of 2025-2026'
  } else if (input.style === 'art' || input.style === 'illustration') {
    primary = 'replicate-sdxl'
    fallbacks.push('replicate-flux', 'stability')
    rationale = 'SDXL with LoRA stack for art styles'
  } else if (input.style === 'product') {
    primary = 'replicate-flux'
    fallbacks.push('openai')
    rationale = 'Flux handles product detail + reflections better than OpenAI'
  } else if (input.style === 'logo') {
    primary = 'openai'
    fallbacks.push('replicate-sdxl')
    rationale = 'DALL-E for vector-like clean shapes'
  }
  if (input.budgetUsd !== undefined && input.budgetUsd < 0.05 && input.budgetUsd > 0) {
    primary = 'gemini-imagen'
    rationale = 'tight budget — cheapest serviceable provider'
  }
  // Always include Pollinations as the bottom-most free fallback.
  if (!fallbacks.includes('pollinations')) fallbacks.push('pollinations')
  return { primary, fallbacks, rationale }
}

// ─── Character consistency plan ─────────────────────────────────────────

export function planCharacterConsistency(input: { workspaceId: string; characterId: string; referenceImageUrls: string[]; numGenerations: number }): {
  strategy: string
  perGen: Array<{ idx: number; seed: number; conditioning: string[] }>
} {
  const seedBase = Math.floor(Math.abs(input.characterId.split('').reduce((s, c) => s + c.charCodeAt(0), 0)))
  const perGen = Array.from({ length: input.numGenerations }, (_, i) => ({
    idx: i,
    seed: seedBase + i,
    conditioning: input.referenceImageUrls.map(u => `ip-adapter:${u}`).slice(0, 3),
  }))
  return {
    strategy: 'IP-Adapter conditioning with 1-3 reference images + character-seeded variation. Use same seed offset family for consistent face/body across batch.',
    perGen,
  }
}

// ─── Upscale + face-fix plan ───────────────────────────────────────────

export function planUpscalePipeline(input: { sourceWidth: number; sourceHeight: number; targetWidth: number; hasFaces?: boolean }): {
  stages: Array<{ stage: string; tool: string; params: Record<string, unknown> }>
} {
  const stages: Array<{ stage: string; tool: string; params: Record<string, unknown> }> = []
  const scale = Math.ceil(input.targetWidth / Math.max(1, input.sourceWidth))
  if (scale > 1) stages.push({ stage: 'upscale', tool: 'real-esrgan', params: { scale, model: scale >= 4 ? 'realesrgan-x4plus' : 'realesrgan-x2plus' } })
  if (input.hasFaces) stages.push({ stage: 'face-restoration', tool: 'gfpgan', params: { weight: 0.7 } })
  stages.push({ stage: 'sharpen-light', tool: 'imagemagick', params: { radius: 0.5, sigma: 0.5 } })
  return { stages }
}

// ─── Style-pack metadata (LoRA-style training brief — actual training out-of-process) ────

export async function defineStylePack(input: { workspaceId: string; businessId: string; name: string; referenceImageUrls: string[]; styleNotes: string }): Promise<{ id: string; trainingBrief: string }> {
  const id = uuidv7()
  const trainingBrief = `Train LoRA "${input.name}" with ${input.referenceImageUrls.length} reference images. Style notes: ${input.styleNotes.slice(0, 500)}. Recommended: 1500 steps, lr=1e-4, network dim=32. Apply during inference as weighted-merge alongside base model.`
  await db.insert(events).values({
    id: uuidv7(), type: 'image.style_pack_defined', workspaceId: input.workspaceId,
    payload: { id, businessId: input.businessId, name: input.name.slice(0, 100), referenceCount: input.referenceImageUrls.length, styleNotes: input.styleNotes.slice(0, 500), trainingBrief: trainingBrief.slice(0, 1000), status: 'pending-training' },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'image-upgrades', version: 1, createdAt: Date.now(),
  })
  return { id, trainingBrief }
}

// ─── Auto-variation testing (generate N + record exposure for selection) ─────

export async function recordVariationExposure(input: { workspaceId: string; promptHash: string; variantId: string; impressionsOrViews: number; conversionsOrClicks: number }): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: 'image.variation_exposure', workspaceId: input.workspaceId,
    payload: { promptHash: input.promptHash.slice(0, 60), variantId: input.variantId.slice(0, 100), impressionsOrViews: input.impressionsOrViews, conversionsOrClicks: input.conversionsOrClicks, ctr: input.impressionsOrViews > 0 ? input.conversionsOrClicks / input.impressionsOrViews : 0 },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'image-upgrades', version: 1, createdAt: Date.now(),
  })
}

export async function variationWinner(workspaceId: string, promptHash: string): Promise<{ winner: string | null; results: Array<{ variantId: string; impressionsOrViews: number; conversionsOrClicks: number; ctr: number }> }> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'image.variation_exposure')))
    .orderBy(desc(events.createdAt)).limit(500)
  const items = rows.map(r => r.payload as Record<string, unknown>).filter(p => p['promptHash'] === promptHash)
  const agg: Record<string, { impressionsOrViews: number; conversionsOrClicks: number }> = {}
  for (const p of items) {
    const v = (p['variantId'] as string) ?? 'unknown'
    if (!agg[v]) agg[v] = { impressionsOrViews: 0, conversionsOrClicks: 0 }
    agg[v].impressionsOrViews += Number(p['impressionsOrViews'] ?? 0)
    agg[v].conversionsOrClicks += Number(p['conversionsOrClicks'] ?? 0)
  }
  const results = Object.entries(agg).map(([variantId, v]) => ({ variantId, ...v, ctr: v.impressionsOrViews > 0 ? v.conversionsOrClicks / v.impressionsOrViews : 0 }))
  results.sort((a, b) => b.ctr - a.ctr)
  return { winner: results[0]?.variantId ?? null, results }
}

// ─── Mockup compositor (plan) ─────────────────────────────────────────

export type MockupKind = 'tshirt-on-model' | 'mug-on-desk' | 'phone-case-flatlay' | 'poster-on-wall' | 'sticker-on-laptop' | 'hoodie-on-model'

export function planMockup(input: { kind: MockupKind; designImageUrl: string; backgroundHint?: 'neutral' | 'lifestyle' | 'studio' }): {
  recipe: string
  layers: Array<{ name: string; source: string; transform: string }>
} {
  const bg = input.backgroundHint ?? 'lifestyle'
  const layers: Array<{ name: string; source: string; transform: string }> = []
  const base = input.kind.replace(/-/g, ' ')
  layers.push({ name: 'background', source: `template:${input.kind}-bg-${bg}`, transform: 'fit' })
  layers.push({ name: 'base-product', source: `template:${input.kind}-product`, transform: 'center' })
  layers.push({ name: 'design', source: input.designImageUrl, transform: 'warp-to-product-area' })
  if (bg === 'lifestyle') layers.push({ name: 'shadow + lighting', source: 'procedural', transform: 'multiply' })
  return { recipe: `Compose ${base} mockup with ${bg} background.`, layers }
}
