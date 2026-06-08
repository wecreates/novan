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
  | 'gumroad' | 'inprnt' | 'fine_art_america'
  | 'redbubble' | 'zazzle' | 'spreadshirt' | 'teepublic' | 'tiktok_shop'
  | 'etsy' | 'displate' | 'threadless'
  // Note: society6 removed Oct 2025 (curated/invitation-only).
  // Note: pixels.com inherits from fine_art_america automatically (no queue entries).

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
  etsy: (s, n) => [
    `Vintage ${capitalize(s)} Printable Wall Art | ${nicheLabel(n)} | Digital Download`,
    `${capitalize(s)} Vintage Illustration Print | Botanical Wall Decor | Instant Download`,
    `Antique ${capitalize(s)} Art Print | Cottagecore | Digital Print`,
  ],
  displate: (s, n) => [
    `Vintage ${capitalize(s)} - ${nicheLabel(n)} Metal Print`,
    `${capitalize(s)} Antique Botanical | Premium Metal Wall Art`,
  ],
  threadless: (s) => [
    `Vintage ${capitalize(s)} Antique`,
    `${capitalize(s)} - Botanical Vintage Design`,
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

  redbubble: (s, n) => `Vintage ${s} antique ${nicheLabel(n)} illustration. Perfect for gallery walls, vintage decor, and lovers of natural-history and classical illustration.`,

  zazzle: (s) => `Vintage ${s} illustration prepared for custom invitations, stationery, and gifts. Color-balanced for premium paper stock.`,

  spreadshirt: (s) => `Vintage ${s} design - antique illustration for premium apparel and accessories.`,

  teepublic: (s) => `Vintage ${s} antique illustration print.`,

  tiktok_shop: (s) => `Vintage ${s} - premium gallery-quality wall art print. Choose your size and finish. Free shipping. Ships from Printful US fulfillment in 2-7 business days.`,

  etsy: (s, n) => `**Vintage ${s} - Printable Wall Art (Instant Digital Download)**

Hand-prepared ${nicheLabel(n)} illustration in the tradition of 19th-century natural-history plates. Soft, warm, archival aesthetic.

**You receive (instant download):**
- High-resolution JPEG (1024x1024+ px)
- Print-ready at 8x10", 11x14", 16x20", A4, A3
- Personal-use license (no resale of the file)

Perfect for cottagecore decor, gallery walls, nursery art, and home offices. Print at home, send to a local print shop, or upload to Shutterfly/MPIX for archival paper.`,

  displate: (s, n) => `Vintage ${s} - ${nicheLabel(n)} metal print. Hand-prepared antique illustration on premium metal substrate. Magnetic mount, no frame needed. Crisp matte finish.`,

  threadless: (s) => `Vintage ${s} antique illustration design. For tees, hoodies, mugs, and tote bags. Color-balanced for direct-to-garment print.`,
}

const BASE_TAGS_BY_PLATFORM: Record<Platform, string[]> = {
  gumroad:           ['digital download', 'wall art', 'printable art', 'vintage print', 'fine art', 'instant download', 'home decor'],
  inprnt:            ['vintage', 'fine art print', 'natural history', 'gallery wall'],
  fine_art_america:  ['vintage', 'fine art print', 'natural history', 'antique illustration', 'gallery wall', 'wall art', 'archival', 'museum quality'],
  redbubble:         ['vintage', 'antique illustration', 'natural history', 'fine art print', 'wall art', 'home decor', 'gallery wall', 'victorian', 'art nouveau', 'museum'],
  zazzle:            ['vintage', 'classic', 'fine art', 'invitation', 'stationery', 'custom', 'wedding', 'event'],
  spreadshirt:       ['vintage', 'apparel', 'fine art', 't-shirt design'],
  teepublic:         ['vintage', 'illustration', 'fine art', 'antique'],
  tiktok_shop:       ['vintagewallart', 'finearthome', 'galleryart', 'antiqueillustration', 'homedecor', 'wallart', 'aesthetichomeward'],
  // Etsy: 13 tag slots; needs broad keyword spread for SEO. Mix singular + plural + variants.
  etsy:              ['vintage', 'wall art', 'printable art', 'digital download', 'instant download', 'cottagecore', 'botanical', 'natural history', 'antique', 'home decor', 'gallery wall', 'nursery art', 'farmhouse'],
  displate:          ['vintage', 'metal print', 'wall decor', 'antique', 'botanical', 'home decor'],
  threadless:        ['vintage', 'botanical', 'antique', 'cottagecore', 'illustration'],
}

const PRICE_BY_PLATFORM: Record<Platform, number> = {
  // Direct retail (digital downloads): operator sets explicit price.
  gumroad:           9,
  // Profile-markup platforms: this is the operator-recommended MARKUP to set
  // on the storefront (R349 doctrine). Platform handles base + markup math.
  inprnt:            8,    // markup over INPRNT base; operator sets in profile
  fine_art_america:  10,   // FAA markup per inch on prints
  redbubble:         20,   // RB margin % on apparel + prints
  zazzle:            15,   // Zazzle designer royalty %
  spreadshirt:       5,    // Spreadshirt designer markup per unit
  teepublic:         0,    // TeePublic = fixed $4 base / $2 sale (operator can't change)
  tiktok_shop:       18,   // TikTok Shop retail print incl Printful margin
  // Direct retail (digital downloads): operator sets explicit price.
  etsy:              7,    // Etsy printable wall art digital download
  displate:          5,    // Displate designer royalty add-on per metal print
  threadless:        6,    // Threadless designer markup per apparel unit
}

const FILE_HINT_BY_PLATFORM: Record<Platform, string> = {
  gumroad:           'Upload PNG (1024x1024+) as the digital download. Optional: pair with a print-ready PDF for the bundle SKU.',
  inprnt:            'Upload PNG at 1500x1500+ pixels minimum. INPRNT auto-crops for product sizing.',
  fine_art_america:  'Upload PNG at 2000x2000+ pixels for maximum print size eligibility. FAA scales down per product.',
  redbubble:         'Upload PNG at 7632x6480+ pixels for all-product compatibility. Use Redbubble Design Wizard for placement.',
  zazzle:            'Upload PNG at 1500x1500+ pixels. For stationery products, 1800x1200 (landscape) recommended.',
  spreadshirt:       'Upload PNG with transparent background for apparel placement. 3000x3000+ recommended.',
  teepublic:         'Upload PNG at 4500x5400 pixels minimum for apparel.',
  tiktok_shop:       'Listing image: 800x800+ for primary, plus 4-6 lifestyle/scale shots. Product photos required.',
  etsy:              'Upload JPEG (1024x1024+) as the digital download. Bundle 5 listing photo variants (mockups) for the Etsy listing carousel.',
  displate:          'Upload PNG at 1465x2092 pixels minimum (3:2 portrait) for Displate metal print. Save with no transparency.',
  threadless:        'Upload PNG at 3000x3000 pixels with transparent background for apparel placement.',
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
  // Strip leading "vintage " from subject so "Vintage ${s}" templates don't
  // double-vintage (e.g. "vintage peony illustration" → "peony illustration").
  // Also strip trailing " illustration" / " print" so "${s} Illustration" templates
  // don't double-illustrate.
  const cleanSubject = input.subject
    .replace(/^vintage\s+/i, '')
    .replace(/\s+(illustration|print|drawing|engraving)$/i, '')
    .trim()
  const inputForTemplates = { ...input, subject: cleanSubject }

  // Use the design id (if provided) or a hash of subject+platform as the rotation seed
  const seed = input.designId
    ? Number.parseInt(input.designId.slice(-8), 16) || 0
    : (cleanSubject + input.platform).split('').reduce((a, c) => a + c.charCodeAt(0), 0)

  const titleOptions = TITLE_PATTERNS[input.platform](cleanSubject, input.niche, input.style)
  const title = rotate(titleOptions, seed)
  const description = DESC_TEMPLATES[input.platform](cleanSubject, input.niche)
  void inputForTemplates  // (placeholder for future template-context expansion)
  const tags = [
    ...BASE_TAGS_BY_PLATFORM[input.platform],
    cleanSubject.replace(/\s+/g, ''),
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
  if (platform === 'redbubble')         return 'Wall Art / Art Prints'
  if (platform === 'zazzle' && niche === 'botanical') return 'Stationery / Botanical'
  if (platform === 'gumroad')           return 'Digital Art / Printable Wall Art'
  if (platform === 'etsy')              return 'Art & Collectibles / Prints / Digital Prints'
  if (platform === 'displate')          return 'Wall Art / Vintage'
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
