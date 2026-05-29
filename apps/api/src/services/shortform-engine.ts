/**
 * shortform-engine.ts — TikTok / YouTube Shorts / Instagram Reels
 * mechanics + content-tier flow model from Part 3 of the spec.
 *
 * Implements:
 *   - Hook-pattern catalog with channel-learned pattern tracking
 *   - Trend detection scoring (sound / format / hashtag) — heuristic,
 *     real implementation feeds from per-platform trend APIs (TikTok
 *     Creative Center / YouTube Trends / Meta Trends) which the
 *     operator wires when connectors land.
 *   - Clip mining heuristics — pick high-engagement moments from
 *     long-form content (transcript-based)
 *   - Performance triage — first-24h early-signal scoring with
 *     pull-and-repost / amplify recommendations
 *   - Content tier flow: Tier 1 flagship → Tier 2 mid-form → Tier 3
 *     short-form → Tier 4 engagement; tracks per-flagship distribution
 *   - Watermark + native-aesthetic guidance per platform
 *
 * Spec scope alignment:
 *   - "Volume over polish" — production economics, not the brain's
 *     decision (operator chooses)
 *   - "AI-augmented humans, not AI-replaced humans" — engine produces
 *     proposals + scores; operator/talent picks finals
 *   - Multi-account: explicit warnings against coordinated inauthentic
 *     behaviour (cross-promotion fine, fake-engagement-between-own-
 *     accounts forbidden); engine refuses to surface engagement-
 *     manipulation tactics.
 */

export type ShortformPlatform = 'tiktok' | 'youtube_shorts' | 'instagram_reels' | 'facebook_reels' | 'snapchat_spotlight' | 'pinterest_idea_pins'

// ── Hook patterns ──────────────────────────────────────────────────
export interface HookPattern {
  id:           string
  pattern:      string
  example:      string
  /** Categories from spec: surprise / question / format / promise / opener. */
  category:     'surprise_claim' | 'question' | 'visual_pattern_interrupt' | 'recognized_format' | 'in_the_action' | 'transformation' | 'controversy' | 'identity'
  /** Recommended placement window in seconds. Most hooks live in 0-3s. */
  placementSeconds: [number, number]
  /** When this pattern works best — narrative voice, topic flavour. */
  worksWhen:    string
  /** Patterns to avoid pairing — over-used combinations. */
  avoid:        string[]
}

const HOOK_PATTERNS: HookPattern[] = [
  {
    id: 'surprise_specific_number',
    pattern: 'Lead with a specific, unexpected number',
    example: '"I made $47,283 last month from a niche nobody talks about."',
    category: 'surprise_claim',
    placementSeconds: [0, 3],
    worksWhen: 'finance, business, productivity — audiences respond to concrete numbers',
    avoid: ['vague claims', 'unverifiable boasts'],
  },
  {
    id: 'contrarian_thesis',
    pattern: 'State the opposite of conventional wisdom',
    example: '"Everyone says to niche down. I made $1M doing the opposite."',
    category: 'controversy',
    placementSeconds: [0, 3],
    worksWhen: 'topics with strong consensus the operator can credibly challenge',
    avoid: ['contrarian-for-contrarian-sake without evidence', 'clickbait that contradicts the body'],
  },
  {
    id: 'pov_format',
    pattern: '"POV: [specific scenario]" — frames as immersive perspective',
    example: '"POV: you\'re the only person in the meeting who\'s read the doc."',
    category: 'recognized_format',
    placementSeconds: [0, 2],
    worksWhen: 'relatable workplace / identity content',
    avoid: ['overused POV setups now blind to the algorithm'],
  },
  {
    id: 'things_i_wish_i_knew',
    pattern: '"Things I wish I knew when [...]"',
    example: '"5 things I wish I knew before starting an Etsy shop."',
    category: 'recognized_format',
    placementSeconds: [0, 3],
    worksWhen: 'list-format educational content',
    avoid: ['generic "things you should know" — must be specific and earned'],
  },
  {
    id: 'tell_me_without',
    pattern: '"Tell me you\'re [X] without telling me you\'re [X]"',
    example: '"Tell me you bootstrapped your business without telling me you bootstrapped your business."',
    category: 'recognized_format',
    placementSeconds: [0, 3],
    worksWhen: 'identity / community recognition humor',
    avoid: ['overused on TikTok since 2021'],
  },
  {
    id: 'transformation_before_after',
    pattern: 'Show before-state immediately, promise after',
    example: '"This is what my Shopify dashboard looked like 30 days ago. Watch this."',
    category: 'transformation',
    placementSeconds: [0, 4],
    worksWhen: 'measurable transformation niches — fitness, business, design',
    avoid: ['transformations the body of the video can\'t prove'],
  },
  {
    id: 'in_the_action',
    pattern: 'Open mid-action — no setup, viewer thrown into scene',
    example: 'Camera on the laptop, screen sharing live; first words are "this is the moment the sale closed"',
    category: 'in_the_action',
    placementSeconds: [0, 2],
    worksWhen: 'documentary-style, behind-the-scenes',
    avoid: ['action without context that pays off'],
  },
  {
    id: 'pattern_interrupt_visual',
    pattern: 'Visual jump-cut, unusual angle, or quick zoom in first 0.5s',
    example: 'Hand sliding across desk → snap to face → text overlay "wait"',
    category: 'visual_pattern_interrupt',
    placementSeconds: [0, 1],
    worksWhen: 'any niche but particularly entertainment + commentary',
    avoid: ['visual interrupt without payoff — viewer feels tricked'],
  },
  {
    id: 'curiosity_question',
    pattern: 'Ask a question the viewer wants to know the answer to',
    example: '"Why do half of POD shops fail in the first 90 days?"',
    category: 'question',
    placementSeconds: [0, 3],
    worksWhen: 'educational + investigative content',
    avoid: ['rhetorical questions everyone already knows the answer to'],
  },
  {
    id: 'identity_hook',
    pattern: 'Direct address to a specific identity the viewer holds',
    example: '"If you\'re a solo founder over 30 watching this at 11pm..."',
    category: 'identity',
    placementSeconds: [0, 4],
    worksWhen: 'B2B + niche audiences with strong identity',
    avoid: ['identities too broad to feel specific'],
  },
]

export function listHookPatterns(): HookPattern[] {
  return HOOK_PATTERNS.slice()
}

/** Score a proposed hook against the catalog. Returns category + risk
 *  signals — the operator decides whether to use. */
export function scoreHook(input: { hookText: string; platform: ShortformPlatform; niche: string }): {
  matchedPatterns: Array<{ id: string; confidence: number }>
  warnings:        string[]
  recommendations: string[]
} {
  const text = input.hookText.toLowerCase()
  const matched: Array<{ id: string; confidence: number }> = []
  if (/\b\d{1,3}(,\d{3})*(\.\d+)?\b/.test(input.hookText)) {
    matched.push({ id: 'surprise_specific_number', confidence: 0.7 })
  }
  if (/^pov[:\s]/.test(text))                                matched.push({ id: 'pov_format',                    confidence: 0.85 })
  if (/^things i wish/.test(text))                            matched.push({ id: 'things_i_wish_i_knew',          confidence: 0.85 })
  if (/^tell me .{1,40} without telling me/.test(text))       matched.push({ id: 'tell_me_without',               confidence: 0.9 })
  if (/\?/.test(input.hookText))                              matched.push({ id: 'curiosity_question',            confidence: 0.5 })
  if (/\b(everyone|most people).{0,30}\b(but|actually|wrong|opposite)\b/.test(text)) {
    matched.push({ id: 'contrarian_thesis', confidence: 0.65 })
  }
  if (/^(if you'?re|to the)\s+[a-z]+/.test(text))             matched.push({ id: 'identity_hook',                 confidence: 0.6 })

  const warnings: string[] = []
  if (input.hookText.length > 100) warnings.push('hook > 100 chars — short-form attention won\'t hold past the first beat; cut by half')
  if (text.startsWith('today we')) warnings.push('"today we\'re going to talk about" pattern kills retention — replace with action or claim')
  if (text.includes('like and subscribe') || text.includes('don\'t forget to')) warnings.push('CTA in hook diverts attention before viewer is invested — move CTA to end')

  const recommendations: string[] = []
  if (matched.length === 0) recommendations.push('no matched pattern — propose a contrarian thesis, specific number, or identity hook (see listHookPatterns())')
  if (input.platform === 'tiktok' && !text.match(/\?/) && matched.every(m => m.id !== 'pattern_interrupt_visual')) {
    recommendations.push('TikTok favours questions or visual interrupts in first 0.5s — verbal hooks alone underperform')
  }
  if (input.platform === 'youtube_shorts' && input.hookText.length < 20) {
    recommendations.push('YouTube Shorts viewers come from broader YouTube; can sustain slightly longer setup')
  }

  return { matchedPatterns: matched, warnings, recommendations }
}

// ── Trend detection scoring ────────────────────────────────────────
export interface TrendSignal {
  platform:    ShortformPlatform
  type:        'sound' | 'format' | 'hashtag' | 'visual_pattern'
  id:          string
  label:       string
  /** Heuristic 0..1 — composite of recency, growth, and competition. */
  momentum:    number
  /** Days since first appearance. */
  ageDays:     number
  /** Estimated views or uses. Order-of-magnitude only. */
  estimatedReach: number
}

/** Score a trend signal for "worth riding" given channel context.
 *  Spec: "Using trending audio gives an algorithmic boost in the early
 *  days of a trend. By the time a trend is obviously trending, it's
 *  often too late." */
export function evaluateTrend(input: {
  trend:         TrendSignal
  channelNiche:  string
  /** Hours from trend identification to publish — production cycle time. */
  productionLeadHours: number
}): {
  ridable:        boolean
  recommendation: 'ride_now' | 'too_late' | 'too_off_niche' | 'wait_for_clearer_signal'
  reason:         string
} {
  // Sweet spot: ageDays < 5, momentum > 0.5, productionLeadHours < 24
  if (input.trend.ageDays > 7 && input.trend.momentum < 0.5) {
    return { ridable: false, recommendation: 'too_late', reason: `${input.trend.ageDays}d old + momentum declining (${(input.trend.momentum * 100).toFixed(0)}%) — algorithm has stopped boosting` }
  }
  if (input.productionLeadHours > 48) {
    return { ridable: false, recommendation: 'too_late', reason: `lead time ${input.productionLeadHours}h — trend will have peaked by publish` }
  }
  if (input.trend.momentum < 0.3) {
    return { ridable: false, recommendation: 'wait_for_clearer_signal', reason: `momentum ${(input.trend.momentum * 100).toFixed(0)}% — risk of riding a non-trend` }
  }
  // Niche fit — naive substring match; operator's manager-agent uses LLM for real semantic fit
  const niche = input.channelNiche.toLowerCase()
  const label = input.trend.label.toLowerCase()
  // If the trend is platform-typical (e.g. "transformation reveal") it's flexibly niche-fit.
  const universalFormats = ['transformation', 'reveal', 'before after', 'tutorial', 'tier list', 'reaction']
  const isUniversal = universalFormats.some(u => label.includes(u))
  if (!isUniversal && !label.includes(niche.split(/\s+/)[0] ?? niche)) {
    return { ridable: false, recommendation: 'too_off_niche', reason: `trend "${input.trend.label}" doesn't fit niche "${input.channelNiche}" — forcing it hurts the channel's interest-graph signal` }
  }
  return {
    ridable: true,
    recommendation: 'ride_now',
    reason: `${input.trend.ageDays}d old · momentum ${(input.trend.momentum * 100).toFixed(0)}% · production lead ${input.productionLeadHours}h — in the sweet spot`,
  }
}

// ── Clip mining ───────────────────────────────────────────────────
export interface TranscriptSegment {
  startSeconds:    number
  endSeconds:      number
  text:            string
  /** Heuristic markers the caller pre-computed: words/sec, laughter,
   *  applause, emphasised volume, etc. */
  energy?:         number    // 0..1
}

export interface CandidateClip {
  startSeconds:    number
  endSeconds:      number
  hookExcerpt:     string
  score:           number    // 0..1
  reason:          string
}

/** Mine high-engagement clips from a long-form transcript. Heuristic:
 *  prefer segments that
 *    (a) contain a candidate hook pattern
 *    (b) have above-mean energy
 *    (c) are 15-60 seconds when extended to natural sentence boundaries
 *    (d) don't overlap with other already-selected clips
 *
 *  Real implementation augments with viewer-retention data (audience
 *  retention curves identify the actual high-engagement moments) — this
 *  module returns candidates; the operator picks finals. */
export function mineClips(input: {
  transcript:    TranscriptSegment[]
  maxClips?:     number
  targetDurationSec?: number
}): CandidateClip[] {
  const max = input.maxClips ?? 10
  const targetDur = input.targetDurationSec ?? 35
  if (input.transcript.length === 0) return []

  const meanEnergy = input.transcript.reduce((s, t) => s + (t.energy ?? 0.5), 0) / input.transcript.length

  // First pass — score each segment.
  const scored = input.transcript.map((seg) => {
    let score = 0
    const reasons: string[] = []
    const hook = scoreHook({ hookText: seg.text, platform: 'tiktok', niche: '' })
    if (hook.matchedPatterns.length > 0) {
      score += 0.4
      reasons.push(`matches hook pattern ${hook.matchedPatterns[0]!.id}`)
    }
    if ((seg.energy ?? 0.5) > meanEnergy + 0.15) {
      score += 0.3
      reasons.push(`high energy (${(seg.energy ?? 0).toFixed(2)} vs mean ${meanEnergy.toFixed(2)})`)
    }
    if (/\b(but|wait|actually|listen|here'?s the thing)\b/i.test(seg.text)) {
      score += 0.15
      reasons.push('contains attention-redirect phrase')
    }
    // Penalise filler-heavy segments
    if (/\b(um|uh|like\b.{0,5}you know|so basically)\b/gi.test(seg.text)) {
      score -= 0.2
      reasons.push('filler-heavy — penalise')
    }
    return { seg, score, reasons }
  })

  // Sort by score desc; greedily pick non-overlapping clips at targetDur.
  scored.sort((a, b) => b.score - a.score)
  const clips: CandidateClip[] = []
  const taken: Array<{ start: number; end: number }> = []
  for (const cand of scored) {
    if (clips.length >= max) break
    if (cand.score <= 0) break
    const center = (cand.seg.startSeconds + cand.seg.endSeconds) / 2
    const start = Math.max(0, center - targetDur / 2)
    const end = start + targetDur
    if (taken.some(t => !(end < t.start || start > t.end))) continue
    taken.push({ start, end })
    clips.push({
      startSeconds: Math.round(start),
      endSeconds:   Math.round(end),
      hookExcerpt:  cand.seg.text.slice(0, 120),
      score:        Number(cand.score.toFixed(3)),
      reason:       cand.reasons.join('; '),
    })
  }
  return clips
}

// ── Performance triage (first-24h signal) ─────────────────────────
export interface EarlyPerformance {
  hoursAgePublished:   number
  views:               number
  likes:               number
  comments:            number
  shares:              number
  saves:               number
  averageWatchPct:     number   // 0..1
  ctrFromImpressions?: number   // 0..1; YouTube Shorts feeds this
}

export interface TriageVerdict {
  verdict:         'pull_and_repost' | 'amplify' | 'let_ride' | 'sunset' | 'too_early_to_tell'
  reason:          string
  metricSnapshot:  Record<string, number>
}

/** Per-platform performance triage. Spec: "short-form performance is
 *  largely determined in the first 24 hours". Pull-and-repost is a real
 *  tactic — if a video underperforms in the first 1-2 hours, delete and
 *  repost (sometimes after thumbnail tweak) to get a fresh initial-
 *  distribution roll. Tactic-specific to TikTok and Reels; not
 *  recommended on YouTube Shorts (you lose accumulated signal). */
export function triagePerformance(input: {
  perf:        EarlyPerformance
  platform:    ShortformPlatform
  channelBaseline: { medianViewsAt24h: number; medianEngagementRate: number }
}): TriageVerdict {
  const { perf, platform, channelBaseline } = input
  const engagementRate = perf.views > 0 ? (perf.likes + perf.comments + perf.shares + perf.saves) / perf.views : 0

  const snapshot = {
    hoursAge:           perf.hoursAgePublished,
    views:              perf.views,
    engagementRate:     Number(engagementRate.toFixed(4)),
    averageWatchPct:    perf.averageWatchPct,
    vsMedianViews:      perf.views / Math.max(1, channelBaseline.medianViewsAt24h),
  }

  if (perf.hoursAgePublished < 2) {
    return { verdict: 'too_early_to_tell', reason: 'less than 2h since publish — algorithmic distribution still ramping', metricSnapshot: snapshot }
  }

  // Pull-and-repost — TikTok/Reels only, and only when signal is
  // genuinely weak (< 30% of median views at this age AND engagement
  // rate < 50% of median).
  const viewsPace = perf.views / Math.max(1, channelBaseline.medianViewsAt24h) * (24 / Math.max(1, perf.hoursAgePublished))
  if (
    (platform === 'tiktok' || platform === 'instagram_reels') &&
    perf.hoursAgePublished < 6 &&
    viewsPace < 0.3 &&
    engagementRate < channelBaseline.medianEngagementRate * 0.5
  ) {
    return {
      verdict: 'pull_and_repost',
      reason:  `${perf.hoursAgePublished}h in, projecting ${(viewsPace * 100).toFixed(0)}% of channel-median 24h views + engagement ${(engagementRate * 100).toFixed(1)}% (vs median ${(channelBaseline.medianEngagementRate * 100).toFixed(1)}%) — pull-and-repost may unlock a fresh distribution roll`,
      metricSnapshot: snapshot,
    }
  }

  // Amplify — over-performing on either views or engagement.
  if (viewsPace > 2 || engagementRate > channelBaseline.medianEngagementRate * 2) {
    return {
      verdict: 'amplify',
      reason:  `over-performing (views pace ${(viewsPace * 100).toFixed(0)}% of median, engagement ${(engagementRate * 100).toFixed(1)}%) — amplify: pin to profile, cross-post, dedicate ad spend, plan follow-up content`,
      metricSnapshot: snapshot,
    }
  }

  // Sunset — past 24h and below 50% of median + low engagement
  if (perf.hoursAgePublished > 24 && viewsPace < 0.5 && engagementRate < channelBaseline.medianEngagementRate * 0.6) {
    return {
      verdict: 'sunset',
      reason:  `past 24h with ${(viewsPace * 100).toFixed(0)}% of median views + low engagement — distribution has stalled, move on to next content`,
      metricSnapshot: snapshot,
    }
  }

  return {
    verdict: 'let_ride',
    reason:  `tracking near median — no intervention needed`,
    metricSnapshot: snapshot,
  }
}

// ── Multi-platform native-aesthetic guidance ──────────────────────
export interface PlatformNativeGuidance {
  platform:         ShortformPlatform
  framing:          string
  hookWindow:       string
  captionStyle:     string
  preferredDuration: string
  watermarkRisks:   string
  notes:            string[]
}

export function getPlatformGuidance(platform: ShortformPlatform): PlatformNativeGuidance {
  switch (platform) {
    case 'tiktok': return {
      platform,
      framing:          '9:16 vertical, full-bleed; phone-shot aesthetic outperforms studio for most niches',
      hookWindow:       '0-2 seconds — hard cap; algorithm bails fast',
      captionStyle:     'TikTok-native dynamic captions (auto-generated or Submagic/Captions); avoid burnt-in static subtitles',
      preferredDuration: '21-34s for max watch-through; up to 60s OK for storytelling',
      watermarkRisks:   'TikTok demotes content with competitor watermarks (esp. CapCut watermark) — strip via SnapTik/SSStik before cross-post',
      notes: [
        'Trending sounds give biggest algorithmic boost — use within first 3-5 days of trend cycle',
        'Hashtags now low-signal; 2-4 specific tags + 1-2 broad',
        'Pinned comment featuring something the video doesn\'t say drives engagement',
      ],
    }
    case 'youtube_shorts': return {
      platform,
      framing:          '9:16 vertical, must be #shorts in title OR upload via Shorts-specific tab',
      hookWindow:       '0-3 seconds — slightly more forgiving than TikTok; subscribers from broader YouTube help',
      captionStyle:     'Native YouTube auto-captions OK; burnt-in fine on Shorts',
      preferredDuration: '30-58s sweet spot; 3min limit since 2024 but >60s loses Shorts-specific distribution',
      watermarkRisks:   'TikTok watermarks DEMOTE on YouTube Shorts — strip before cross-post',
      notes: [
        'Subscribe button from Shorts has real conversion — first-hour comment response drives subscribes',
        'End screens redirect to long-form — Shorts→long-form funnel is the strategic move',
        'Existing channel authority provides some lift (vs cold-start on TikTok)',
      ],
    }
    case 'instagram_reels': return {
      platform,
      framing:          '9:16 vertical, full-bleed; can crop to 4:5 for in-feed visibility but loses Reels-tab priority',
      hookWindow:       '0-2 seconds',
      captionStyle:     'Dynamic native captions; consider Instagram-specific font choices',
      preferredDuration: '7-30s for max distribution; up to 90s acceptable',
      watermarkRisks:   'Instagram demotes TikTok-watermarked content aggressively',
      notes: [
        'Reels Audio library has its own trending sounds — TikTok trends arrive on IG with 1-2 week lag',
        'Cross-posting from IG Stories does NOT perform as well as native Reels',
        'IG commerce integration strong — products in frame get shoppable tags',
      ],
    }
    case 'facebook_reels': return {
      platform,
      framing:          '9:16 vertical',
      hookWindow:       '0-3 seconds',
      captionStyle:     'Burnt-in subtitles essential; FB audience skews older + sound-off viewing',
      preferredDuration: '15-60s',
      watermarkRisks:   'Less strict but still penalises TikTok watermarks',
      notes: [
        'Older + broader demographics than IG Reels',
        'Meta cross-promotes Reels across IG + FB ecosystem',
      ],
    }
    case 'snapchat_spotlight': return {
      platform,
      framing:          '9:16 vertical, full-bleed',
      hookWindow:       '0-2 seconds',
      captionStyle:     'Snap-native AR captions + stickers preferred',
      preferredDuration: '7-30s',
      watermarkRisks:   'Strict — strip all third-party watermarks',
      notes: ['Younger demographics; commerce features in earlier stage than IG/TikTok'],
    }
    case 'pinterest_idea_pins': return {
      platform,
      framing:          '9:16 vertical idea pins; multi-page format unique to Pinterest',
      hookWindow:       'first-page hook dominates — multi-page rewards completion',
      captionStyle:     'Pinterest-style text overlays + page transitions',
      preferredDuration: 'multi-page, each page 5-15s',
      watermarkRisks:   'Pinterest is more permissive but quality bar high',
      notes: ['Stronger for visual-product niches (home, fashion, food, beauty) — limited for general content'],
    }
  }
}

// ── Content tier flow (Part 3 of the spec) ────────────────────────
export interface ContentTierFlow {
  tier1Source: {
    id:       string
    format:   'long_form_video' | 'podcast_episode' | 'long_form_written'
    title:    string
    publishedAt?: number
  }
  /** Tier 2 derived from Tier 1. */
  tier2: Array<{ format: 'twitter_thread' | 'linkedin_post' | 'instagram_carousel' | 'blog_post' | 'youtube_long_extract' | 'newsletter_section'; status: 'planned' | 'drafted' | 'published'; ref?: string }>
  /** Tier 3 derived from Tier 1 + Tier 2. */
  tier3: Array<{ platform: ShortformPlatform; status: 'planned' | 'edited' | 'published'; clipRef?: string; ref?: string }>
  /** Tier 4 ongoing engagement — usually unstructured. */
  tier4Notes: string[]
  /** Expected leverage ratio — how many distinct content pieces per 1 Tier-1. */
  leverageRatio: number
}

/** Recommend a tier-2 / tier-3 distribution plan from a single Tier 1.
 *  Spec target: 25-50 distinct pieces of content per week, from 1
 *  Tier 1 source. This function proposes the breakdown; operator
 *  customises per channel charter. */
export function planTierDistribution(input: {
  tier1: ContentTierFlow['tier1Source']
  /** Channels the operator runs — engine picks platforms with active channels. */
  activeShortformPlatforms: ShortformPlatform[]
  /** Operator has a newsletter? podcast? */
  hasNewsletter: boolean
  hasPodcast: boolean
  hasLinkedinPresence: boolean
}): ContentTierFlow {
  const tier2: ContentTierFlow['tier2'] = []
  if (input.hasNewsletter)        tier2.push({ format: 'newsletter_section',   status: 'planned' })
  tier2.push({ format: 'twitter_thread',       status: 'planned' })
  if (input.hasLinkedinPresence)  tier2.push({ format: 'linkedin_post',        status: 'planned' })
  tier2.push({ format: 'instagram_carousel',   status: 'planned' })
  tier2.push({ format: 'blog_post',            status: 'planned' })
  if (input.tier1.format === 'podcast_episode') {
    tier2.push({ format: 'youtube_long_extract', status: 'planned' })
  }

  // Tier 3 — 5-10 short clips per platform = 15-30 total for a 3-platform op.
  const tier3: ContentTierFlow['tier3'] = []
  const clipsPerPlatform = input.tier1.format === 'long_form_video' ? 8 : 5
  for (const p of input.activeShortformPlatforms) {
    for (let i = 0; i < clipsPerPlatform; i++) {
      tier3.push({ platform: p, status: 'planned' })
    }
  }

  const leverageRatio = tier2.length + tier3.length + 4   // +4 for Tier 4 engagement layer
  return {
    tier1Source: input.tier1,
    tier2,
    tier3,
    tier4Notes: [
      'Stories / IG + FB — re-share Tier 2 carousel pages individually',
      'X replies + community comments referencing this Tier 1',
      'DMs + email reply to engaged audience members with deeper content',
      'Discord / Circle / Slack post highlighting the Tier 1 with discussion prompt',
    ],
    leverageRatio,
  }
}

// ── Multi-account ethics guard ────────────────────────────────────
/** Spec: "running large numbers of accounts edges into terms-of-
 *  service territory on most platforms... distinct content, distinct
 *  purpose, distinct creative direction, not engagement manipulation
 *  between accounts." This refuses to surface manipulation tactics
 *  and flags any plan that crosses the line. */
export function checkMultiAccountPlan(input: {
  accountCount:        number
  contentDistinct:     boolean
  purposeDistinct:     boolean
  creativeDirection:   'distinct_per_account' | 'shared_template_acceptable' | 'identical'
  crossEngagement:     'organic_cross_promotion' | 'engagement_between_own_accounts' | 'none'
}): { ok: boolean; reasons: string[]; allowedTactics: string[]; refusedTactics: string[] } {
  const reasons: string[] = []
  if (!input.contentDistinct)     reasons.push('content must be distinct per account — identical reposts violate ToS on TikTok / Meta / YouTube')
  if (!input.purposeDistinct)     reasons.push('accounts must have distinct purpose — duplicate-purpose accounts trigger coordinated-inauthentic-behaviour detection')
  if (input.creativeDirection === 'identical') reasons.push('identical creative direction is the platform-anti-pattern — even shared template should produce visibly distinct output')
  if (input.crossEngagement === 'engagement_between_own_accounts') reasons.push('engagement BETWEEN your own accounts (likes / comments / shares) violates ToS — this is fake engagement, refused')

  return {
    ok: reasons.length === 0,
    reasons,
    allowedTactics: [
      'cross-promotion via genuine recommendation (one account mentions the other to its audience)',
      'shared production infrastructure (same editor, same designer)',
      'shared sponsorship sales operation',
      'unified content calendar coordinated by the brain',
      'language / region splits with localised content',
    ],
    refusedTactics: [
      'engagement between your own accounts (likes, comments, shares)',
      'identical content posted to multiple accounts',
      'follow-trains / engagement pods',
      'view-bot or like-bot services',
      'fake comment networks',
    ],
  }
}
