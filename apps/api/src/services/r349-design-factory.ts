/**
 * R146.349 — Design Factory
 *
 * Generates designs at scale via the existing image-generator (HF/Together
 * primary), tagged by niche + style. Variants of winning designs (color
 * shift, crop, reframe) multiply output without triggering duplicate-
 * detection on platforms.
 *
 * No publish here — pure asset production. Operator uploads.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'

export type DesignNiche =
  | 'botanical' | 'nautical' | 'vintage_map' | 'japanese_woodblock'
  | 'natural_history' | 'antique_portrait' | 'landscape' | 'still_life'
  | 'animal_audubon' | 'architecture' | 'pattern_decorative' | 'celestial'
  | 'mythology' | 'art_nouveau' | 'medieval_illumination'

export type DesignStyle =
  | 'watercolor' | 'line_art' | 'etched' | 'ink_wash' | 'gouache'
  | 'engraving' | 'lithograph' | 'mid_century_modern' | 'minimalist'

export interface DesignCatalogEntry {
  id:              string
  workspaceId:     string
  niche:           DesignNiche
  style:           DesignStyle
  prompt:          string
  imageUrl:        string
  source:          'ai_gen' | 'public_domain' | 'operator_upload'
  sourceProvider?: string
  parentDesignId?: string
  variantType?:    'color_shift' | 'crop' | 'reframe'
  qualityScore:    number
  isLiveCount:     number
  createdAt:       number
}

const PROMPT_TEMPLATES: Record<DesignNiche, string[]> = {
  botanical: [
    'vintage botanical illustration of {{subject}}, fine art print, gallery quality',
    'classical botanical study of {{subject}} on cream paper, soft hand-colored, museum collection',
    '19th century botanical plate of {{subject}}, archival quality, decorative wall art',
  ],
  nautical: [
    'vintage nautical chart with {{subject}}, antique parchment, sepia and burnt orange tones, ornamental compass rose',
    'classical maritime illustration of {{subject}}, watercolor and ink, museum quality fine art',
  ],
  vintage_map: [
    'decorative vintage map of {{subject}} in the style of 17th-18th century cartography, ornamental flourishes, sepia tones',
    'antique world map fragment featuring {{subject}}, fine engraving lines, parchment background',
  ],
  japanese_woodblock: [
    'Japanese ukiyo-e woodblock print of {{subject}}, traditional flat colors, fine line work',
    'Edo period woodblock illustration of {{subject}}, indigo and red ink, gallery print',
  ],
  natural_history: [
    'vintage natural history illustration of {{subject}}, hand-colored study, scientific accuracy with artistic warmth',
    '19th century scientific plate of {{subject}}, museum archival quality, fine detail',
  ],
  antique_portrait: [
    'classical antique portrait of {{subject}}, oil painting style, dramatic chiaroscuro, museum gallery',
    'vintage formal portrait illustration of {{subject}}, archival fine art print quality',
  ],
  landscape: [
    'vintage landscape painting of {{subject}}, romantic 19th century style, atmospheric perspective, warm cream tones',
    'classical landscape illustration of {{subject}}, gallery quality fine art print',
  ],
  still_life: [
    'vintage still life painting of {{subject}}, Dutch golden age style, dramatic lighting, museum quality',
    'classical still life study of {{subject}}, oil painting on cream canvas, fine art print',
  ],
  animal_audubon: [
    'vintage natural history illustration of {{subject}}, soft hand-colored watercolor on cream paper, after Audubon, fine detail',
    'Audubon-style ornithological study of {{subject}}, archival gallery print quality',
  ],
  architecture: [
    'vintage architectural drawing of {{subject}}, fine engraving lines, cross-section detail, museum quality',
    'classical architectural elevation of {{subject}}, sepia ink on parchment',
  ],
  pattern_decorative: [
    'vintage decorative pattern featuring {{subject}}, Art Nouveau style, ornamental, gallery print',
    'antique tapestry-style pattern of {{subject}}, rich color, museum quality',
  ],
  celestial: [
    'vintage astronomical chart of {{subject}}, fine engraving, gold leaf accents, dark blue background',
    '19th century celestial map showing {{subject}}, ornamental flourishes, fine art print',
  ],
  mythology: [
    'classical mythological illustration of {{subject}}, Renaissance style, fine line art on cream, museum quality',
    'vintage mythological scene featuring {{subject}}, allegorical, archival gallery print',
  ],
  art_nouveau: [
    'Art Nouveau illustration of {{subject}}, flowing organic lines, decorative border, Mucha style',
    'Belle Epoque poster art featuring {{subject}}, jewel tones, ornamental, fine art print',
  ],
  medieval_illumination: [
    'medieval illuminated manuscript style illustration of {{subject}}, gold leaf, intricate border, monastery scriptorium',
    'vintage gothic-style decorative illustration of {{subject}}, parchment, sepia and gold',
  ],
}

const NEGATIVE_PROMPT = 'text, watermark, signature, blurry, low quality, modern, photograph, deformed, ugly, amateur'

function pickStyleForNiche(niche: DesignNiche): DesignStyle {
  // Reasonable default style per niche
  const map: Partial<Record<DesignNiche, DesignStyle>> = {
    botanical: 'watercolor',
    nautical: 'ink_wash',
    vintage_map: 'engraving',
    japanese_woodblock: 'lithograph',
    natural_history: 'watercolor',
    animal_audubon: 'watercolor',
    architecture: 'line_art',
    art_nouveau: 'lithograph',
    celestial: 'engraving',
    medieval_illumination: 'gouache',
  }
  return map[niche] ?? 'watercolor'
}

function pickTemplate(niche: DesignNiche, idx = 0): string {
  const templates = PROMPT_TEMPLATES[niche]
  return templates[idx % templates.length]!
}

// ─── Generation ─────────────────────────────────────────────────────────────

export interface GenerateBatchInput {
  workspaceId:      string
  niche:            DesignNiche
  subjects:         string[]                 // e.g. ['iris', 'sunflower', 'fern', ...]
  styleOverride?:   DesignStyle
  promptTemplateIndex?: number               // rotate through niche templates
}

export interface GenerateBatchResult {
  generated: DesignCatalogEntry[]
  failed:    Array<{ subject: string; error: string }>
}

export async function generateBatch(input: GenerateBatchInput): Promise<GenerateBatchResult> {
  const { generateImage } = await import('./image-generator.js')
  const style = input.styleOverride ?? pickStyleForNiche(input.niche)
  const template = pickTemplate(input.niche, input.promptTemplateIndex ?? 0)
  const generated: DesignCatalogEntry[] = []
  const failed: Array<{ subject: string; error: string }> = []

  for (const subject of input.subjects) {
    const prompt = template.replace('{{subject}}', subject)
    try {
      const r = await generateImage({
        workspaceId:    input.workspaceId,
        provider:       'huggingface',
        prompt,
        negativePrompt: NEGATIVE_PROMPT,
        width:          1024, height: 1024,
        budgetCapUsd:   0.01,
        createdBy:      'r349-design-factory',
      })
      if (r.status === 'succeeded' && r.imageUrl) {
        const entry = await persistDesign({
          workspaceId:    input.workspaceId,
          niche:          input.niche,
          style,
          prompt,
          imageUrl:       r.imageUrl,
          source:         'ai_gen',
          sourceProvider: 'huggingface',
        })
        generated.push(entry)
      } else {
        failed.push({ subject, error: r.errorMessage ?? 'generation returned non-success status' })
      }
    } catch (e) {
      failed.push({ subject, error: (e as Error).message.slice(0, 200) })
    }
  }
  return { generated, failed }
}

async function persistDesign(input: {
  workspaceId:    string
  niche:          DesignNiche
  style:          DesignStyle
  prompt:         string
  imageUrl:       string
  source:         'ai_gen' | 'public_domain' | 'operator_upload'
  sourceProvider?: string
  parentDesignId?: string
  variantType?:   'color_shift' | 'crop' | 'reframe'
  qualityScore?:  number
}): Promise<DesignCatalogEntry> {
  const id = uuidv7()
  const now = Date.now()
  const qs = input.qualityScore ?? 70
  await db.execute(sql`
    INSERT INTO design_catalog (id, workspace_id, niche, style, prompt, image_url, source, source_provider, parent_design_id, variant_type, quality_score, is_live_count, created_at)
    VALUES (${id}, ${input.workspaceId}, ${input.niche}, ${input.style}, ${input.prompt}, ${input.imageUrl}, ${input.source}, ${input.sourceProvider ?? null}, ${input.parentDesignId ?? null}, ${input.variantType ?? null}, ${qs}, 0, ${now})
  `)
  const entry: DesignCatalogEntry = {
    id, workspaceId: input.workspaceId, niche: input.niche, style: input.style,
    prompt: input.prompt, imageUrl: input.imageUrl, source: input.source,
    qualityScore: qs, isLiveCount: 0, createdAt: now,
  }
  if (input.sourceProvider)  entry.sourceProvider  = input.sourceProvider
  if (input.parentDesignId)  entry.parentDesignId  = input.parentDesignId
  if (input.variantType)     entry.variantType     = input.variantType
  return entry
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listDesigns(opts: {
  workspaceId: string
  niche?:      DesignNiche
  limit?:      number
  recent?:     boolean
}): Promise<DesignCatalogEntry[]> {
  const limit = opts.limit ?? 50
  try {
    const rows = opts.niche
      ? await db.execute(sql`
          SELECT id, workspace_id, niche, style, prompt, image_url, source, source_provider, parent_design_id, variant_type, quality_score, is_live_count, created_at
          FROM design_catalog
          WHERE workspace_id = ${opts.workspaceId} AND niche = ${opts.niche}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `)
      : await db.execute(sql`
          SELECT id, workspace_id, niche, style, prompt, image_url, source, source_provider, parent_design_id, variant_type, quality_score, is_live_count, created_at
          FROM design_catalog
          WHERE workspace_id = ${opts.workspaceId}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `)
    return (rows as unknown as Array<Record<string, unknown>>).map(r => ({
      id:             String(r['id']),
      workspaceId:    String(r['workspace_id']),
      niche:          String(r['niche']) as DesignNiche,
      style:          String(r['style']) as DesignStyle,
      prompt:         String(r['prompt']),
      imageUrl:       String(r['image_url']).slice(0, 200) + (String(r['image_url']).length > 200 ? '...[truncated]' : ''),
      source:         String(r['source']) as 'ai_gen' | 'public_domain' | 'operator_upload',
      ...(r['source_provider']  ? { sourceProvider:  String(r['source_provider']) } : {}),
      ...(r['parent_design_id'] ? { parentDesignId:  String(r['parent_design_id']) } : {}),
      ...(r['variant_type']     ? { variantType:     String(r['variant_type']) as 'color_shift' | 'crop' | 'reframe' } : {}),
      qualityScore:   Number(r['quality_score']) || 70,
      isLiveCount:    Number(r['is_live_count']) || 0,
      createdAt:      Number(r['created_at']) || 0,
    }))
  } catch (e) {
    console.error('[r349-design-factory] listDesigns failed:', (e as Error).message)
    return []
  }
}

/** Suggested subject lists per niche, drawn from POD bestseller data. */
export const NICHE_SUBJECTS: Record<DesignNiche, string[]> = {
  botanical:           ['iris flower', 'sunflower', 'fern leaf', 'rose study', 'magnolia branch', 'cactus blossom', 'wild daisy', 'eucalyptus sprig'],
  nautical:            ['anchor and rope', 'lighthouse beam', 'whale fluke', 'compass rose', 'sailing ship at dusk', 'maritime knot collection'],
  vintage_map:         ['old world atlas page', 'Pacific islands chart', 'European coastline', 'star constellation chart', 'antique celestial sphere'],
  japanese_woodblock:  ['wave with mountain', 'cherry blossom branch', 'koi fish in pond', 'Mount Fuji at sunrise', 'crane in flight'],
  natural_history:     ['butterfly specimen', 'beetle collection', 'mushroom variety study', 'shell collection', 'leaf identification'],
  antique_portrait:    ['Renaissance noblewoman', 'Victorian gentleman', 'classical philosopher bust', 'Romantic-era poet'],
  landscape:           ['English countryside hills', 'Tuscan valley', 'Norwegian fjord', 'Highland glen', 'Provence lavender field'],
  still_life:          ['fruit and silver vessel', 'fresh cut flowers in vase', 'classical books and quill', 'oysters and lemon'],
  animal_audubon:      ['ivory-billed woodpecker', 'snowy owl', 'painted bunting', 'great blue heron', 'pileated woodpecker', 'mountain lion study'],
  architecture:        ['Gothic cathedral cross-section', 'classical column orders', 'Renaissance dome blueprint', 'medieval castle plan'],
  pattern_decorative:  ['William Morris floral', 'Persian carpet motif', 'Art Deco geometric', 'Celtic knotwork'],
  celestial:           ['zodiac wheel', 'lunar phases chart', 'Orion constellation', 'planetary orbits diagram'],
  mythology:           ['Athena and owl', 'Pegasus in flight', 'Orpheus with lyre', 'siren on rocks'],
  art_nouveau:         ['woman with peacock', 'lily and dragonfly', 'four seasons allegory', 'Belle Epoque poster muse'],
  medieval_illumination:['bestiary lion', 'illuminated initial letter', 'monastery garden plan', 'celestial choir scene'],
}
