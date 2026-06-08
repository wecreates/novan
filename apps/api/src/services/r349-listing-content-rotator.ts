/**
 * R146.349 — Listing Content Rotator
 *
 * For one design, produce platform-tuned title / description / tags / pricing.
 * Same design gets distinct copy on each platform so no template/duplicate
 * signal across platforms.
 *
 * No LLM call required — uses curated templates + niche-aware substitution.
 * Can be upgraded to LLM-generated later when prompt-evolution shows tier-1
 * platforms need stronger copy.
 */

import type { DesignNiche, DesignStyle } from './r349-design-factory.js'

export type Platform =
  | 'gumroad' | 'inprnt' | 'fine_art_america' | 'society6'
  | 'redbubble' | 'zazzle' | 'spreadshirt' | 'teepublic' | 'tiktok_shop'

export interface ListingContent {
  platform:     Platform
  title:        string
  description:  string
  tags:         string[]
  priceUsd:     number
  category?:    string
  fileFormatHint: string         // what to upload: PNG, PSD+PDF bundle, etc.
}

// ─── Per-platform tone templates ────────────────────────────────────────────

const TITLE_PATTERNS: Record<Platform, (subject: string, niche: DesignNiche, style: DesignStyle) => string[]> = {
  gumroad: (s) => [
    `${capitalize(s)} - Vintage Fine Art Digital Download`,
    `${capitalize(s)} Print - Instant Download (PNG + PDF)`,
    `Vintage ${capitalize(s)} - High-Res Wall Art Download`,
  ],
  inprnt: (s) => [
    `Vintage ${capitalize(s)}`,
    `${capitalize(s)} Study`,
    `${capitalize(s)} - Antique Illustration`,
  ],
  fine_art_america: (s, n) => [
    `Vintage ${capitalize(s)} - ${nicheLabel(n)}`,
    `${capitalize(s)} Antique Print`,
    `Classical ${capitalize(s)} Illustration`,
  ],
  society6: (s, n) => [
    `Vintage ${capitalize(s)} ${nicheLabel(n)} Print`,
    `Antique ${capitalize(s)} Illustration`,
    `${capitalize(s)} Botanical Vintage Art`,
  ],
  redbubble: (s, n) => [
    `Vintage ${capitalize(s)} ${nicheLabel(n)} Antique Illustration`,
    `${capitalize(s)} Vintage Natural History Print`,
    `Antique ${capitalize(s)} Decorative Wall Art Print`,
  ],
  zazzle: (s) => [
    `Vintage ${capitalize(s)} Card`,
    `Classical ${capitalize(s)} Stationery Design`,
    `${capitalize(s)} - Custom Vintage Print`,
  ],
  spreadshirt: (s) => [
    `Vintage ${capitalize(s)} Design`,
    `Classical ${capitalize(s)} Print Apparel`,
  ],
  teepublic: (s) => [
    `Vintage ${capitalize(s)}`,
    `${capitalize(s)} Antique Style`,
  ],
  tiktok_shop: (s, n) => [
    `Vintage ${capitalize(s)} Wall Art Print | ${nicheLabel(n)}`,
    `${capitalize(s)} Vintage Print | Premium Gallery Art`,
  ],
}

const DESC_TEMPLATES: Record<Platform, (subject: string, niche: DesignNiche) => string> = {
  gumroad: (s, n) => `**Vintage ${s} - ${nicheLabel(n)} Fine Art Print.**

Hand-crafted illustration in the tradition of 19th-century natural-history plates. Soft, warm, and substantive - the kind of image that lives on a wall for years.

**You get:**
- High-resolution PNG (1024 x 1024+ px)
- Print-ready at 8x10", 11x14", 16x20"
- Color-balanced for matte paper
- Personal-use license

Print at home, at a local print shop, or send to a custom frame shop.`,

  inprnt: (s) => `${capitalize(s)} - vintage fine-art illustration prepared from public-domain archival sources.

Pairs with botanical, natural-history, and antique cartography prints.`,

  fine_art_america: (s, n) => `${capitalize(s)} - ${nicheLabel(n)} vintage fine art print.

Hand-prepared from archival public-domain sources in the tradition of 19th-century natural-history plates. Color-balanced for modern matte papers and frames. Available framed, on canvas, on metal, on acrylic, or as a poster. Shipped worldwide by Fine Art America's archival fulfillment.`,

  society6: (s, n) => `Vintage ${s} - antique ${nicheLabel(n)} illustration for your gallery wall. Pairs with botanical and natural-history prints in matte or framed format.`,

  redbubble: (s, n) => `Vintage ${s} antique ${nicheLabel(n)} illustration. Perfect for gallery walls, vintage decor, and lovers of natural-history and classical illustration.`,

  zazzle: (s) => `Vintage ${s} illustration prepared for custom invitations, stationery, and gifts. Color-balanced for premium paper stock.`,

  spreadshirt: (s) => `Vintage ${s} design - antique illustration for premium apparel and accessories.`,

  teepublic: (s) => `Vintage ${s} antique illustration print.`,

  tiktok_shop: (s) => `Vintage ${s} - premium gallery-quality wall art print. Choose your size and finish. Free shipping. Ships from Printful US fulfillment in 2-7 business days.`,
}

const BASE_TAGS_BY_PLATFORM: Record<Platform, string[]> = {
  gumroad:           ['digital download', 'wall art', 'printable art', 'vintage print', 'fine art', 'instant download', 'home decor'],
  inprnt:            ['vintage', 'fine art print', 'natural history', 'gallery wall'],
  fine_art_america:  ['vintage', 'fine art print', 'natural history', 'antique illustration', 'gallery wall', 'wall art', 'archival', 'museum quality'],
  society6:          ['vintage', 'antique', 'fine art', 'wall art', 'home decor', 'art print', 'illustration', 'gallery wall'],
  redbubble:         ['vintage', 'antique illustration', 'natural history', 'fine art print', 'wall art', 'home decor', 'gallery wall', 'victorian', 'art nouveau', 'museum'],
  zazzle:            ['vintage', 'classic', 'fine art', 'invitation', 'stationery', 'custom', 'wedding', 'event'],
  spreadshirt:       ['vintage', 'apparel', 'fine art', 't-shirt design'],
  teepublic:         ['vintage', 'illustration', 'fine art', 'antique'],
  tiktok_shop:       ['vintagewallart', 'finearthome', 'galleryart', 'antiqueillustration', 'homedecor', 'wallart', 'aesthetichomeward'],
}

const PRICE_BY_PLATFORM: Record<Platform, number> = {
  gumroad: 9, inprnt: 0, fine_art_america: 0, society6: 0,
  redbubble: 0, zazzle: 0, spreadshirt: 0, teepublic: 0, tiktok_shop: 0,
  // The 0s mean: platform price is base + markup configured in profile (R343 set FAA);
  // the operator-take is computed from there, not from price here.
}

const FILE_HINT_BY_PLATFORM: Record<Platform, string> = {
  gumroad:           'Upload PNG (1024x1024+) as the digital download. Optional: pair with a print-ready PDF for the bundle SKU.',
  inprnt:            'Upload PNG at 1500x1500+ pixels minimum. INPRNT auto-crops for product sizing.',
  fine_art_america:  'Upload PNG at 2000x2000+ pixels for maximum print size eligibility. FAA scales down per product.',
  society6:          'Upload PNG at 6500x6500+ pixels for full product catalog eligibility (large canvases need it).',
  redbubble:         'Upload PNG at 7632x6480+ pixels for all-product compatibility. Use Redbubble Design Wizard for placement.',
  zazzle:            'Upload PNG at 1500x1500+ pixels. For stationery products, 1800x1200 (landscape) recommended.',
  spreadshirt:       'Upload PNG with transparent background for apparel placement. 3000x3000+ recommended.',
  teepublic:         'Upload PNG at 4500x5400 pixels minimum for apparel.',
  tiktok_shop:       'Listing image: 800x800+ for primary, plus 4-6 lifestyle/scale shots. Product photos required.',
}

// ─── Public API ─────────────────────────────────────────────────────────────

function rotate<T>(arr: T[], seed: number): T {
  const i = ((seed % arr.length) + arr.length) % arr.length
  return arr[i]!
}

function capitalize(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function nicheLabel(n: DesignNiche): string {
  const map: Record<DesignNiche, string> = {
    botanical: 'Botanical', nautical: 'Nautical', vintage_map: 'Cartography',
    japanese_woodblock: 'Ukiyo-e', natural_history: 'Natural History',
    antique_portrait: 'Portrait', landscape: 'Landscape', still_life: 'Still Life',
    animal_audubon: 'Audubon Animal', architecture: 'Architectural',
    pattern_decorative: 'Decorative Pattern', celestial: 'Celestial',
    mythology: 'Mythology', art_nouveau: 'Art Nouveau',
    medieval_illumination: 'Medieval Illumination',
  }
  return map[n]
}

export function generateListing(input: {
  platform:    Platform
  subject:     string                                  // e.g. 'iris flower'
  niche:       DesignNiche
  style:       DesignStyle
  designId?:   string                                  // for rotation seed
}): ListingContent {
  // Use the design id (if provided) or a hash of subject+platform as the rotation seed
  const seed = input.designId
    ? Number.parseInt(input.designId.slice(-8), 16) || 0
    : (input.subject + input.platform).split('').reduce((a, c) => a + c.charCodeAt(0), 0)

  const titleOptions = TITLE_PATTERNS[input.platform](input.subject, input.niche, input.style)
  const title = rotate(titleOptions, seed)
  const description = DESC_TEMPLATES[input.platform](input.subject, input.niche)
  const tags = [
    ...BASE_TAGS_BY_PLATFORM[input.platform],
    input.subject.replace(/\s+/g, ''),
    nicheLabel(input.niche).toLowerCase().replace(/\s+/g, ''),
  ]
  return {
    platform:       input.platform,
    title,
    description,
    tags,
    priceUsd:       PRICE_BY_PLATFORM[input.platform],
    fileFormatHint: FILE_HINT_BY_PLATFORM[input.platform],
    category:       categoryFor(input.platform, input.niche),
  }
}

function categoryFor(platform: Platform, niche: DesignNiche): string | undefined {
  if (platform === 'fine_art_america') return 'Wall Art / Fine Art Prints / Vintage'
  if (platform === 'society6')          return 'Art Prints / Vintage'
  if (platform === 'redbubble')         return 'Wall Art / Art Prints'
  if (platform === 'zazzle' && niche === 'botanical') return 'Stationery / Botanical'
  if (platform === 'gumroad')           return 'Digital Art / Printable Wall Art'
  return undefined
}

/**
 * Convenience: generate listings for the same design across multiple platforms.
 * Used by the daily-briefing flow.
 */
export function generateMultiPlatform(input: {
  platforms:  Platform[]
  subject:    string
  niche:      DesignNiche
  style:      DesignStyle
  designId?:  string
}): ListingContent[] {
  return input.platforms.map(p => generateListing({
    platform: p, subject: input.subject, niche: input.niche, style: input.style,
    ...(input.designId ? { designId: input.designId } : {}),
  }))
}
