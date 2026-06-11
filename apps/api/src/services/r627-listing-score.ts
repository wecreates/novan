/**
 * R627 — Listing SEO score + pricing optimizer.
 *
 *   listing.score     — score a proposed listing (title, description, tags,
 *                       price) against POD best-practice rubric.
 *   listing.improve   — LLM-rewrite a low-scoring listing toward higher
 *                       score (preserving operator's voice).
 *   pricing.optimize  — given current price + margin + platform, suggest
 *                       raise/lower with reasoning.
 *
 * Scoring is heuristic + LLM. Heuristic catches obvious mistakes
 * (wrong length, missing tags). LLM catches keyword opportunity.
 */
import type { ChatMsg } from './chat-providers.js'

export type Platform = 'etsy' | 'gumroad' | 'inprnt' | 'redbubble' | 'fineartamerica' | 'tiktok_shop' | 'shopify' | 'generic'

export interface ListingInput {
  title:        string
  description?: string
  tags?:        string[]
  price?:       number       // USD
  platform?:    Platform
}

export interface ListingScore {
  total:       number       // 0-100
  buckets: {
    title:       number    // 0-25
    description: number    // 0-25
    tags:        number    // 0-20
    pricing:     number    // 0-15
    keywords:    number    // 0-15
  }
  issues:      string[]
  strengths:   string[]
}

// ─── Heuristic scoring ───────────────────────────────────────────────────────

const PLATFORM_LIMITS: Record<Platform, { titleMax: number; tagMax: number; descMin: number; descMax: number; tagsMin: number; tagsMax: number }> = {
  etsy:           { titleMax: 140, tagMax: 20, descMin: 80,  descMax: 4000, tagsMin: 10, tagsMax: 13 },
  gumroad:        { titleMax: 100, tagMax: 30, descMin: 60,  descMax: 6000, tagsMin: 3,  tagsMax: 10 },
  inprnt:         { titleMax: 100, tagMax: 30, descMin: 60,  descMax: 2000, tagsMin: 5,  tagsMax: 15 },
  redbubble:      { titleMax: 50,  tagMax: 25, descMin: 60,  descMax: 600,  tagsMin: 5,  tagsMax: 15 },
  fineartamerica: { titleMax: 100, tagMax: 30, descMin: 80,  descMax: 4000, tagsMin: 8,  tagsMax: 30 },
  tiktok_shop:    { titleMax: 100, tagMax: 0,  descMin: 100, descMax: 3000, tagsMin: 0,  tagsMax: 0  },
  shopify:        { titleMax: 70,  tagMax: 50, descMin: 100, descMax: 8000, tagsMin: 3,  tagsMax: 20 },
  generic:        { titleMax: 100, tagMax: 30, descMin: 60,  descMax: 4000, tagsMin: 5,  tagsMax: 15 },
}

function scoreHeuristic(input: ListingInput): ListingScore {
  const platform = input.platform ?? 'generic'
  const lim = PLATFORM_LIMITS[platform]
  const issues: string[] = []
  const strengths: string[] = []

  // Title (25)
  let titleScore = 25
  const title = input.title.trim()
  if (!title) { titleScore = 0; issues.push('title empty') }
  else if (title.length < 20) { titleScore -= 10; issues.push(`title too short (${title.length} chars; aim ≥40)`) }
  else if (title.length > lim.titleMax) { titleScore -= 12; issues.push(`title exceeds ${platform} cap (${title.length}/${lim.titleMax})`) }
  if (title === title.toUpperCase() && title.length > 8) { titleScore -= 5; issues.push('title is ALL CAPS') }
  if (/!{2,}|\?{2,}/.test(title)) { titleScore -= 3; issues.push('repeated punctuation in title') }
  if (titleScore >= 20) strengths.push('title length + format good')

  // Description (25)
  let descScore = 25
  const desc = (input.description ?? '').trim()
  if (!desc) { descScore = 0; issues.push('description empty') }
  else if (desc.length < lim.descMin) { descScore -= 12; issues.push(`description too short (${desc.length}; aim ≥${lim.descMin})`) }
  else if (desc.length > lim.descMax) { descScore -= 8; issues.push(`description exceeds ${platform} cap (${desc.length}/${lim.descMax})`) }
  const sentences = desc.split(/[.!?]\s+/).filter(s => s.trim().length > 5).length
  if (sentences < 3 && desc.length > 0) { descScore -= 5; issues.push('description lacks structure (<3 sentences)') }
  if (descScore >= 20) strengths.push('description well-developed')

  // Tags (20)
  let tagScore = 20
  const tags = (input.tags ?? []).map(t => t.trim()).filter(Boolean)
  if (lim.tagsMax > 0) {
    if (tags.length < lim.tagsMin) { tagScore -= 10; issues.push(`only ${tags.length} tags (aim ≥${lim.tagsMin})`) }
    if (tags.length > lim.tagsMax) { tagScore -= 5;  issues.push(`${tags.length} tags exceeds ${platform} cap (${lim.tagsMax})`) }
    const dupes = tags.length - new Set(tags.map(t => t.toLowerCase())).size
    if (dupes > 0) { tagScore -= 4; issues.push(`${dupes} duplicate tags`) }
    const overlong = tags.filter(t => t.length > lim.tagMax)
    if (overlong.length > 0) { tagScore -= 3; issues.push(`${overlong.length} tags over ${lim.tagMax} chars`) }
    if (tagScore >= 16) strengths.push('tag count + uniqueness good')
  } else {
    tagScore = 20    // platform doesn't use tags
  }

  // Pricing (15) — only checks plausibility; full optimization in pricing.optimize
  let priceScore = 15
  if (typeof input.price === 'number' && input.price > 0) {
    if (input.price < 1)   { priceScore -= 8; issues.push(`price <$1 unrealistic for POD margin`) }
    if (input.price > 500) { priceScore -= 4; issues.push('price >$500 — confirm tier matches buyer expectations') }
    if (priceScore >= 12) strengths.push('price in plausible POD range')
  } else {
    priceScore -= 5; issues.push('no price provided')
  }

  // Keywords (15) — naive overlap between title + tags
  let kwScore = 15
  const titleTokens = new Set(title.toLowerCase().match(/[a-z]{3,}/g) ?? [])
  const tagTokens = new Set(tags.flatMap(t => t.toLowerCase().match(/[a-z]{3,}/g) ?? []))
  const overlap = [...titleTokens].filter(t => tagTokens.has(t)).length
  if (overlap < 2 && tags.length > 0) { kwScore -= 8; issues.push('title and tags share <2 keywords — search-relevance gap') }
  else if (overlap >= 4) strengths.push(`${overlap} title↔tag keywords align`)

  const total = Math.max(0, Math.min(100, titleScore + descScore + tagScore + priceScore + kwScore))
  return {
    total,
    buckets: { title: titleScore, description: descScore, tags: tagScore, pricing: priceScore, keywords: kwScore },
    issues,
    strengths,
  }
}

// ─── Public: score ──────────────────────────────────────────────────────────

export async function score(input: ListingInput): Promise<ListingScore> {
  if (!input.title?.trim()) throw new Error('title required')
  return scoreHeuristic(input)
}

// ─── Public: improve (LLM rewrite for higher score) ─────────────────────────

export interface ImproveResult {
  before:   ListingScore
  after:    ListingScore
  proposed: ListingInput
  changes:  string[]
  tokens:   number
  costUsd:  number
}

export async function improve(workspaceId: string, input: ListingInput): Promise<ImproveResult> {
  const before = await score(input)
  const platform = input.platform ?? 'generic'
  const lim = PLATFORM_LIMITS[platform]

  const msgs: ChatMsg[] = [
    {
      role: 'system',
      content: `You optimize POD product listings. Rewrite the given listing to score higher on ${platform}. Constraints:
- title ≤ ${lim.titleMax} chars, target 40–${Math.round(lim.titleMax * 0.85)}
- description ≥ ${lim.descMin} chars, ≤ ${lim.descMax}
- ${lim.tagsMax > 0 ? `${lim.tagsMin}–${lim.tagsMax} tags, ≤ ${lim.tagMax} chars each, no duplicates` : 'no tags on this platform'}
- preserve the operator's voice and the actual product
- title and tags must share ≥4 keywords for search alignment
- output ONLY a JSON object: { "title": string, "description": string, "tags": string[], "changes": string[] }`,
    },
    {
      role: 'user',
      content: `Platform: ${platform}\nCurrent score: ${before.total}/100\nIssues to fix:\n${before.issues.map(i => `- ${i}`).join('\n')}\n\nCurrent listing:\n${JSON.stringify({ title: input.title, description: input.description, tags: input.tags, price: input.price })}`,
    },
  ]

  const { streamChat } = await import('./chat-providers.js')
  const t0 = Date.now()
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: true })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value

  try {
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({ workspaceId, provider: final.provider, model: final.model, promptTokens: 0, outputTokens: final.tokens, costUsd: final.costUsd, latencyMs: Date.now() - t0, taskType: 'chat' })
  } catch { /* tolerated */ }

  // Robust JSON extraction
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('LLM did not return JSON')
  let parsed: { title?: string; description?: string; tags?: string[]; changes?: string[] }
  try { parsed = JSON.parse(jsonMatch[0]) } catch { throw new Error('JSON parse failed') }

  const proposed: ListingInput = {
    title:       parsed.title ?? input.title,
    description: parsed.description ?? input.description ?? '',
    tags:        Array.isArray(parsed.tags) ? parsed.tags : (input.tags ?? []),
  }
  if (typeof input.price === 'number') proposed.price = input.price
  if (input.platform) proposed.platform = input.platform

  const after = await score(proposed)
  return { before, after, proposed, changes: parsed.changes ?? [], tokens: final.tokens, costUsd: final.costUsd }
}

// ─── Pricing optimizer ──────────────────────────────────────────────────────

export interface PricingInput {
  currentPrice:  number
  cogs:          number          // cost of goods (printer cost)
  platform:      Platform
  category?:     string          // 'wall_art', 'tshirt', 'mug', etc.
  marketLow?:    number          // observed competitor low
  marketHigh?:   number
  marketMedian?: number
}

export interface PricingSuggestion {
  current:   { price: number; marginUsd: number; marginPct: number }
  suggested: { price: number; marginUsd: number; marginPct: number }
  direction: 'raise' | 'lower' | 'hold'
  reasoning: string[]
  confidence: 'low' | 'medium' | 'high'
}

const PLATFORM_FLOOR_MARGIN = {
  etsy: 0.40, gumroad: 0.70, inprnt: 0.30, redbubble: 0.20, fineartamerica: 0.25, tiktok_shop: 0.30, shopify: 0.50, generic: 0.35,
} as const

export async function optimizePrice(input: PricingInput): Promise<PricingSuggestion> {
  const { currentPrice, cogs, platform } = input
  if (!(currentPrice > 0)) throw new Error('currentPrice > 0 required')
  if (!(cogs >= 0)) throw new Error('cogs >= 0 required')
  const minMarginPct = PLATFORM_FLOOR_MARGIN[platform]

  const curMargin = currentPrice - cogs
  const curMarginPct = curMargin / currentPrice

  const reasoning: string[] = []
  let suggestedPrice = currentPrice
  let confidence: 'low' | 'medium' | 'high' = 'low'

  // 1) Floor: ensure platform-min margin
  const floor = Math.ceil((cogs / (1 - minMarginPct)) * 100) / 100
  if (currentPrice < floor) {
    suggestedPrice = floor
    reasoning.push(`current margin ${(curMarginPct * 100).toFixed(0)}% is below ${platform} floor ${(minMarginPct * 100).toFixed(0)}%; raise to $${floor.toFixed(2)}`)
    confidence = 'high'
  }

  // 2) Market band: hug the median
  if (typeof input.marketMedian === 'number' && input.marketMedian > 0) {
    const median = input.marketMedian
    if (currentPrice > median * 1.25) {
      const target = Math.max(floor, median * 1.05)
      suggestedPrice = Math.min(suggestedPrice === currentPrice ? target : suggestedPrice, target)
      reasoning.push(`current $${currentPrice.toFixed(2)} is 25%+ above market median $${median.toFixed(2)}; lower toward $${target.toFixed(2)}`)
      confidence = 'medium'
    } else if (currentPrice < median * 0.75) {
      const target = Math.max(floor, median * 0.95)
      suggestedPrice = Math.max(suggestedPrice, target)
      reasoning.push(`current $${currentPrice.toFixed(2)} is 25%+ below median $${median.toFixed(2)}; raise toward $${target.toFixed(2)} — leaves room for sales/coupons`)
      confidence = 'medium'
    } else {
      reasoning.push(`current $${currentPrice.toFixed(2)} within ±25% of median $${median.toFixed(2)} — hold`)
      if (confidence === 'low') confidence = 'medium'
    }
  }

  // 3) Charm pricing — round to .99 or .95 for retail psychology
  const cents = Math.round(suggestedPrice * 100) % 100
  if (cents !== 99 && cents !== 95 && cents !== 0 && suggestedPrice > 5) {
    const charmed = Math.floor(suggestedPrice) + 0.99
    if (charmed >= floor) {
      suggestedPrice = charmed
      reasoning.push(`charm-priced to $${charmed.toFixed(2)} for retail-psychology lift`)
    }
  }

  const sugMargin = suggestedPrice - cogs
  const sugMarginPct = sugMargin / suggestedPrice
  const direction: PricingSuggestion['direction'] = Math.abs(suggestedPrice - currentPrice) < 0.5 ? 'hold' : (suggestedPrice > currentPrice ? 'raise' : 'lower')

  return {
    current:   { price: currentPrice,  marginUsd: Number(curMargin.toFixed(2)), marginPct: Number((curMarginPct * 100).toFixed(1)) },
    suggested: { price: Number(suggestedPrice.toFixed(2)), marginUsd: Number(sugMargin.toFixed(2)), marginPct: Number((sugMarginPct * 100).toFixed(1)) },
    direction,
    reasoning,
    confidence,
  }
}
