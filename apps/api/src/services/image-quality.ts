/**
 * image-quality.ts — pure scoring engines that the Creative Director
 * stack runs against every generation.
 *
 *   - scorePrompt(prompt)     → quality + slop-risk + composition heuristics
 *   - scoreGeneration(meta)   → combines prompt score with provider/seed
 *                               metadata + operator rating when present
 *   - isPromptUnsafe(prompt)  → trademark / impersonation / illegal flags
 *
 * Pure functions only. No DB, no fetch. The route layer wraps these and
 * persists rollups; tests drive them with fixtures so the heuristics
 * stay deterministic and reviewable.
 *
 * Design constraints (from the directive):
 *   - Anti-slop: detect generic AI look, overused styles, low-effort
 *     prompts, malformed-anatomy markers, muddy compositions.
 *   - Originality: detect direct copying, trademark/impersonation, style
 *     cloning. Block when high-confidence; warn otherwise.
 *   - Premium standard: every output carries quality + originality +
 *     slop-risk + composition scores in [0, 1].
 */

export interface PromptScore {
  qualityScore:     number    // 0..1, higher is better
  slopRisk:         number    // 0..1, higher is worse
  compositionScore: number    // 0..1, higher is better
  originalityScore: number    // 0..1, higher is better
  brandFitScore:    number    // 0..1, higher is better — requires brand context to be meaningful
  flags:            string[]  // human-readable reasons (audit)
}

export interface ImageScoreInput {
  prompt:           string
  enhancedPrompt?:  string | null
  stylePreset?:     string | null
  brandCategory?:   string | null
  userRating?:      number | null    // 1..5
  provider?:        string | null
  latencyMs?:       number | null
}

// ─── Slop-pattern detection ─────────────────────────────────────────────
// These tokens push slop-risk UP. They are common low-effort modifiers
// and "AI look" cliches that flood public image marketplaces.
const SLOP_TOKENS = [
  /\b(8k|4k|ultra[- ]?hd|ultra[- ]?realistic|hyper[- ]?realistic|hyperrealistic)\b/i,
  /\b(masterpiece|best quality|award[- ]?winning|trending on artstation)\b/i,
  /\b(insanely detailed|extremely detailed|highly detailed|intricate details)\b/i,
  /\b(photorealistic|cinematic lighting|epic lighting|volumetric lighting)\b/i,
  /\b(bokeh|dof|shallow depth of field)\b.*\b(portrait|woman|girl|man)\b/i,
  /\b(vivid colors|vibrant colors|surreal|dreamy|magical)\b/i,
  /\b(stable diffusion|midjourney|dalle?|sora)\b/i,
]

// Overused subjects/contexts associated with low-effort AI farms.
const SLOP_THEME_TOKENS = [
  /\b(cyberpunk|neon city|samurai cat|wojak|chibi|anime girl)\b/i,
  /\b(viking warrior|fantasy elf|dragon|wizard tower|knight on horse)\b/i,
  /\b(coffee shop|cozy room|wholesome scene)\b/i,
  /\b(astronaut riding|astronaut on a horse|cat in space)\b/i,
]

// Composition markers — presence increases composition score.
const GOOD_COMPOSITION = [
  /\b(rule of thirds|negative space|leading lines|asymmetric|centered composition)\b/i,
  /\b(wide shot|tight crop|over[- ]the[- ]shoulder|isometric|orthographic)\b/i,
  /\b(natural light|soft light|directional light|hard shadow|window light)\b/i,
  /\b(monochrome|duotone|limited palette|complementary colors|earth tones)\b/i,
]

// Style markers that suggest deliberate art direction (positive signal).
const PREMIUM_STYLE = [
  /\b(editorial|architectural|product photography|studio shot|commercial photography)\b/i,
  /\b(swiss design|brutalist|bauhaus|minimal|modernist|typographic)\b/i,
  /\b(film grain|kodak portra|fujifilm|medium format|large format)\b/i,
]

// Originality risk — phrases that suggest copying a specific style / brand.
const TRADEMARK_HINTS = [
  /\bin the style of (?!a |an |the )([A-Z][\w-]+(?:\s+[A-Z][\w-]+)?)\b/,
  /\b(disney|pixar|marvel|nintendo|apple|tesla|nike|adidas|coca[- ]?cola|pepsi|amazon|google|microsoft|youtube)\b/i,
  /\b(banksy|picasso|van gogh|warhol|monet|dali|kahlo)\b/i,
  /\b(mickey mouse|spider-?man|batman|superman|iron man|hello kitty|pokemon)\b/i,
]
const IMPERSONATION_HINTS = [
  /\b(logo of|official mark of|exact copy of|replica of)\b/i,
  /\b(fake|counterfeit|knock[- ]?off)\b/i,
]

// Unsafe / illegal patterns — always blocked.
const UNSAFE = [
  /\b(child\s|csam|cp\b)/i,
  /\b(weapon manufacturing|bomb instructions|how to make a (?:bomb|gun))\b/i,
  /\b(deepfake|nude (?:of|version of) [A-Z][\w-]+|naked celebrity)\b/i,
  /\bporn(?:ographic)?\b.*\b(child|minor|underage)\b/i,
]

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }

export function scorePrompt(prompt: string): PromptScore {
  const flags: string[] = []
  const t = (prompt ?? '').trim()
  const words = t.split(/\s+/).filter(Boolean)
  const wordCount = words.length

  if (wordCount < 3) flags.push('low-effort:too-short')
  if (wordCount > 80) flags.push('verbose:too-long')

  let slopHits = 0
  for (const re of SLOP_TOKENS)       if (re.test(t)) { slopHits++; flags.push(`slop-token:${re.source.slice(0, 40)}`) }
  for (const re of SLOP_THEME_TOKENS) if (re.test(t)) { slopHits += 0.6; flags.push(`slop-theme:${re.source.slice(0, 40)}`) }

  let compositionHits = 0
  for (const re of GOOD_COMPOSITION) if (re.test(t)) { compositionHits++; flags.push(`composition:${re.source.slice(0, 40)}`) }

  let premiumHits = 0
  for (const re of PREMIUM_STYLE) if (re.test(t)) { premiumHits++; flags.push(`premium-style:${re.source.slice(0, 40)}`) }

  // Originality: trademark / impersonation hits drop the score sharply.
  let trademarkHits = 0
  for (const re of TRADEMARK_HINTS) if (re.test(t)) { trademarkHits++; flags.push(`trademark-hint`) }
  let impersonationHits = 0
  for (const re of IMPERSONATION_HINTS) if (re.test(t)) { impersonationHits++; flags.push(`impersonation-hint`) }

  // Composition score: 0.4 base + 0.15 per marker, capped.
  const compositionScore = clamp01(0.4 + 0.15 * compositionHits + 0.05 * premiumHits)

  // Quality: base 0.55, up for length-in-range + composition + premium hits,
  // down for slop hits.
  let quality = 0.55
  if (wordCount >= 8 && wordCount <= 40) quality += 0.10
  if (premiumHits > 0)                   quality += 0.05 * premiumHits
  if (compositionHits > 0)               quality += 0.04 * compositionHits
  quality -= 0.08 * slopHits
  if (wordCount < 3) quality -= 0.20
  const qualityScore = clamp01(quality)

  // Slop risk: pure slop-hit density, normalized to ~1.0 at 5 hits.
  const slopRisk = clamp01(slopHits / 5)

  // Originality: starts at 0.85, drops with trademark/impersonation hits.
  const originalityScore = clamp01(0.85 - 0.25 * trademarkHits - 0.35 * impersonationHits)

  // Brand-fit: cannot be meaningfully scored without a brand context; 0.5 = neutral.
  const brandFitScore = 0.5

  return { qualityScore, slopRisk, compositionScore, originalityScore, brandFitScore, flags }
}

export interface GenerationVerdict {
  /** 0..1 weighted composite (quality + originality - slop) for sorting. */
  composite:     number
  /** True if this should be REJECTED from the gallery. */
  shouldReject:  boolean
  /** True if this should be flagged for manual review. */
  shouldFlag:    boolean
  promptScore:   PromptScore
  reasons:       string[]
}

export function scoreGeneration(input: ImageScoreInput): GenerationVerdict {
  const promptScore = scorePrompt(input.enhancedPrompt ?? input.prompt)
  const reasons: string[] = []

  // Operator rating boost (1..5 → -0.2 .. +0.2)
  let composite = 0.4 * promptScore.qualityScore
                + 0.3 * promptScore.originalityScore
                + 0.2 * promptScore.compositionScore
                - 0.3 * promptScore.slopRisk
  if (typeof input.userRating === 'number') {
    composite += (input.userRating - 3) * 0.10
    reasons.push(`user-rating:${input.userRating}`)
  }
  composite = clamp01(0.5 + composite / 2)   // normalize into [0,1]

  // Latency penalty — generations over 30 s feel sluggish in a premium UI
  if (typeof input.latencyMs === 'number' && input.latencyMs > 30_000) {
    composite -= 0.05
    reasons.push('latency:slow')
  }
  composite = clamp01(composite)

  const shouldReject = promptScore.flags.some(f => f.startsWith('impersonation-hint'))
                    || promptScore.originalityScore < 0.4
                    || (promptScore.slopRisk > 0.8 && promptScore.qualityScore < 0.4)
  const shouldFlag = !shouldReject && (
                       promptScore.slopRisk > 0.5 ||
                       promptScore.flags.includes('trademark-hint') ||
                       promptScore.qualityScore < 0.5)

  return { composite: Number(composite.toFixed(3)), shouldReject, shouldFlag, promptScore, reasons }
}

// ─── Prompt safety classifier ──────────────────────────────────────────

export interface PromptSafetyVerdict {
  kind:    'allow' | 'review' | 'block'
  reason?: string
  matched?: string
}

export function isPromptUnsafe(prompt: string): PromptSafetyVerdict {
  const t = (prompt ?? '').trim()
  if (!t) return { kind: 'allow' }
  for (const re of UNSAFE) {
    const m = t.match(re)
    if (m) return { kind: 'block', reason: 'illegal_or_harmful', matched: m[0] }
  }
  for (const re of IMPERSONATION_HINTS) {
    const m = t.match(re)
    if (m) return { kind: 'block', reason: 'impersonation', matched: m[0] }
  }
  for (const re of TRADEMARK_HINTS) {
    const m = t.match(re)
    if (m) return { kind: 'review', reason: 'trademark_reference', matched: m[0] }
  }
  return { kind: 'allow' }
}

// ─── Anti-slop prompt rewriting (pure heuristic) ───────────────────────

const REWRITE_REMOVE: Array<{ re: RegExp; replacement: string }> = [
  { re: /\b(8k|4k|ultra[- ]?hd|hyper[- ]?realistic|insanely detailed|extremely detailed|highly detailed|intricate details|trending on artstation|masterpiece,?|best quality,?|award[- ]?winning,?)\b/gi, replacement: '' },
  { re: /\s{2,}/g, replacement: ' ' },
  { re: /\s+,/g, replacement: ',' },
  { re: /,+/g, replacement: ',' },
  { re: /(^,|,$)/g, replacement: '' },
]

const REWRITE_PROMOTE = [
  'natural light',
  'editorial framing',
  'subtle film grain',
  'restrained palette',
  'considered composition',
]

/**
 * Heuristic anti-slop rewrite — strips overused modifiers and softly
 * promotes editorial style cues. Used by the "reduce slop" voice
 * command and the "improve prompt" button.
 */
export function antiSlopRewrite(prompt: string): { prompt: string; removed: string[]; added: string[] } {
  let out = prompt
  const removed: string[] = []
  for (const r of REWRITE_REMOVE) {
    const before = out
    out = out.replace(r.re, r.replacement)
    if (before !== out) removed.push(r.re.source.slice(0, 50))
  }
  out = out.trim()

  // Only add editorial cues if the prompt doesn't already have similar
  // signal — avoid stuffing the result with another set of cliches.
  const lower = out.toLowerCase()
  const added: string[] = []
  if (!/\b(natural|window|directional|soft) light\b/.test(lower)) {
    out += ', ' + REWRITE_PROMOTE[0]
    added.push(REWRITE_PROMOTE[0]!)
  }
  if (!/\b(composition|framing|crop|shot)\b/.test(lower)) {
    out += ', ' + REWRITE_PROMOTE[1]
    added.push(REWRITE_PROMOTE[1]!)
  }
  return { prompt: out.trim(), removed, added }
}

/** Make prompt explicitly premium — used by "make more premium" voice. */
export function premiumRewrite(prompt: string): { prompt: string; added: string[] } {
  const base = antiSlopRewrite(prompt)
  const lower = base.prompt.toLowerCase()
  const cues = ['editorial photography', 'restrained palette', 'subtle film grain']
  const added: string[] = []
  for (const c of cues) {
    if (!lower.includes(c)) {
      base.prompt += ', ' + c
      added.push(c)
    }
  }
  return { prompt: base.prompt.trim(), added: [...base.added, ...added] }
}
