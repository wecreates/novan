/**
 * social-upgrades.ts — R146.92 — social media management gaps:
 *  cross-platform repurposing, engagement-response queue, cadence engine,
 *  audience overlap detection, crisis handler, influencer discovery.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, desc, eq, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'x-twitter' | 'reddit' | 'pinterest' | 'linkedin'

// ─── Cross-platform repurposing pipeline ───────────────────────────────────

export function planRepurposing(input: { sourcePlatform: Platform; sourceFormat: 'video' | 'image' | 'text-thread' | 'blog-post'; targetPlatforms: Platform[]; durationSec?: number }): {
  variants: Array<{ platform: Platform; format: string; transforms: string[]; estimatedMinutes: number }>
} {
  const variants = input.targetPlatforms.filter(p => p !== input.sourcePlatform).map(p => {
    const transforms: string[] = []
    const baseMin = input.sourceFormat === 'video' ? 5 : 2
    if (input.sourceFormat === 'video') {
      if (p === 'youtube')   transforms.push('keep 16:9 or transcode to 16:9 if vertical', 'rewrite title for SEO', 'cards + endscreen', 'chapters from script beats')
      if (p === 'tiktok')    transforms.push('crop to 9:16', 'add trending sound', 'caption burn', 'first-3s hook tightened')
      if (p === 'instagram') transforms.push('crop to 9:16 for Reels or 1:1 for feed', 'cover frame selection', 'caption hook in first line')
      if (p === 'x-twitter') transforms.push('clip 30-60s highlight', 'add hook tweet referencing thread', 'reply with full link')
      if (p === 'pinterest') transforms.push('pull 3-5 hero frames as static pins', 'idea-pin variant 1:1.85', 'SEO-optimized pin title + description')
      if (p === 'reddit')    transforms.push('extract one strong segment', 'native upload (no YouTube link in body)', 'community-fit description')
      if (p === 'linkedin')  transforms.push('trim to 90s max', 'professional caption framing', 'tag relevant company pages')
    } else if (input.sourceFormat === 'blog-post') {
      if (p === 'youtube')   transforms.push('script for talking-head video', 'voiceover + b-roll visual track', 'thumbnail + title')
      if (p === 'tiktok' || p === 'instagram') transforms.push('compress to 60s carousel or video', 'one-point-per-slide format')
      if (p === 'x-twitter') transforms.push('thread of 5-9 tweets', 'first tweet = hook, last = full-link')
      if (p === 'pinterest') transforms.push('quote-card pins', 'long-form pin description (300-500 chars)')
      if (p === 'reddit')    transforms.push('community-fit summary', 'link in comment, not post body, when allowed')
      if (p === 'linkedin')  transforms.push('long-form post with line-break formatting', 'reaction hook in first 2 lines')
    } else if (input.sourceFormat === 'image') {
      if (p === 'pinterest') transforms.push('upload as is + add 3 keyword-rich titles')
      if (p === 'instagram') transforms.push('feed post + carousel variant')
      if (p === 'x-twitter') transforms.push('attach to text post')
    } else if (input.sourceFormat === 'text-thread') {
      if (p === 'youtube')   transforms.push('expand into video script')
      if (p === 'instagram') transforms.push('carousel adaptation, 1 idea per slide')
      if (p === 'pinterest') transforms.push('quote-card series')
    }
    return { platform: p, format: derivedFormat(input.sourceFormat, p), transforms, estimatedMinutes: baseMin + transforms.length * 2 }
  })
  return { variants }
}

function derivedFormat(src: string, p: Platform): string {
  if (src === 'video') {
    if (p === 'youtube') return 'video-16:9'
    if (p === 'tiktok' || p === 'instagram') return 'video-9:16'
    if (p === 'x-twitter') return 'video-clip-30-60s'
    if (p === 'pinterest') return 'pin + idea-pin'
    if (p === 'linkedin') return 'video-90s-max'
    if (p === 'reddit') return 'native-upload'
  }
  return 'derived'
}

// ─── Engagement-response queue ─────────────────────────────────────────────

export async function queueEngagementResponse(input: { workspaceId: string; platform: Platform; sourceId: string; sourceType: 'comment' | 'dm' | 'mention'; authorHandle?: string; originalText: string; draftedReply: string; sentiment?: 'positive' | 'neutral' | 'negative' }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'social.response_queued', workspaceId: input.workspaceId,
    payload: { id, platform: input.platform, sourceId: input.sourceId.slice(0, 100), sourceType: input.sourceType, authorHandle: (input.authorHandle ?? '').slice(0, 100), originalText: input.originalText.slice(0, 1000), draftedReply: input.draftedReply.slice(0, 800), sentiment: input.sentiment ?? 'neutral', status: 'pending-approval' },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'social-upgrades', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listPendingResponses(workspaceId: string, platform?: Platform): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'social.response_queued')))
    .orderBy(desc(events.createdAt)).limit(200)
  const items = rows.map(r => r.payload as Record<string, unknown>).filter(p => p['status'] === 'pending-approval')
  return platform ? items.filter(p => p['platform'] === platform) : items
}

// ─── Cadence engine (per platform optimal cadence + next-best-time) ──────

export function recommendCadence(input: { platform: Platform; audienceTimezones?: string[]; currentPostsPerWeek?: number }): {
  optimalPostsPerWeek: number
  optimalHoursLocal: number[]
  rationale: string
} {
  const tz = (input.audienceTimezones ?? ['America/Los_Angeles'])[0]
  const guides: Record<Platform, { ppw: number; hours: number[]; reason: string }> = {
    'youtube':     { ppw: 1,  hours: [14, 15, 16],         reason: 'long-form: 1/wk consistent beats 3/wk inconsistent; afternoon launches catch evening commute' },
    'tiktok':      { ppw: 14, hours: [7, 8, 19, 20, 21],   reason: '2/day required for algorithm signal; morning + evening peaks' },
    'instagram':   { ppw: 7,  hours: [9, 12, 18],          reason: '1/day Reels + 2-3 feed posts/wk; lunch + evening peaks' },
    'x-twitter':   { ppw: 35, hours: [7, 12, 17, 20, 22],  reason: '5/day to stay in feed; spread morning to late night' },
    'reddit':      { ppw: 2,  hours: [8, 18],              reason: 'low-frequency, high-quality; karma penalty for spam; respect 9:1 self-promo' },
    'pinterest':   { ppw: 14, hours: [20, 21, 22],         reason: '2/day fresh pins; evening peak; pins compound for months' },
    'linkedin':    { ppw: 3,  hours: [7, 8, 12],           reason: 'business-hours posts win; 3/wk Tue-Thu optimal' },
  }
  const g = guides[input.platform]
  return { optimalPostsPerWeek: g.ppw, optimalHoursLocal: g.hours, rationale: `${g.reason} (timezone hint: ${tz})` }
}

// ─── Audience overlap detection ────────────────────────────────────────

export function estimateAudienceOverlap(input: { platforms: Array<{ platform: Platform; followerCount: number }>; estimatedUniqueReach?: number }): {
  totalFollowers: number
  estimatedUniqueReach: number
  overlapPct: number
  recommendation: string
} {
  const totalFollowers = input.platforms.reduce((s, p) => s + p.followerCount, 0)
  // Without per-follower data, model overlap as a function of platform mix
  // Crude defaults: IG+TikTok have high overlap (60%); TikTok+X less (30%); IG+Pinterest low (15%)
  let multiplier = 1.0
  const set = new Set(input.platforms.map(p => p.platform))
  if (set.has('instagram') && set.has('tiktok')) multiplier -= 0.25
  if (set.has('tiktok') && set.has('x-twitter')) multiplier -= 0.1
  if (set.has('instagram') && set.has('youtube')) multiplier -= 0.15
  multiplier = Math.max(0.3, multiplier)
  const estimatedUniqueReach = input.estimatedUniqueReach ?? Math.round(totalFollowers * multiplier)
  const overlapPct = totalFollowers > 0 ? Math.round((1 - estimatedUniqueReach / totalFollowers) * 100) : 0
  let recommendation = 'audience well-diversified across platforms'
  if (overlapPct >= 50) recommendation = 'high overlap — most "new" followers are existing ones; diversify into a 3rd platform with a different audience'
  else if (overlapPct >= 30) recommendation = 'moderate overlap — consider whether marginal $ on platform N+1 beats deeper investment on existing platforms'
  return { totalFollowers, estimatedUniqueReach, overlapPct, recommendation }
}

// ─── Crisis handler (triage + response framework) ───────────────────────

export async function triageNegativeFeedbackCluster(input: { workspaceId: string; platform: Platform; clusterSize: number; sample: string[]; topThemes: string[] }): Promise<{
  severity: 'low' | 'medium' | 'high' | 'critical'
  recommendedActions: string[]
}> {
  const severity: 'low' | 'medium' | 'high' | 'critical' =
    input.clusterSize >= 50 ? 'critical' :
    input.clusterSize >= 20 ? 'high' :
    input.clusterSize >= 8  ? 'medium' : 'low'
  const actions: string[] = []
  if (severity === 'critical') actions.push('PAUSE all scheduled posts on this platform', 'operator notified immediately', 'consider holding statement within 2 hours')
  if (severity === 'high')     actions.push('hold next 3 scheduled posts for operator review', 'draft public-response statement', 'identify whether claim has any merit')
  if (severity === 'medium')   actions.push('respond to top 3 threads with empathy + clarity', 'monitor next 24h')
  if (severity === 'low')      actions.push('respond individually where appropriate', 'log themes for future content review')
  await db.insert(events).values({
    id: uuidv7(), type: 'social.crisis_triaged', workspaceId: input.workspaceId,
    payload: { platform: input.platform, clusterSize: input.clusterSize, severity, topThemes: input.topThemes.slice(0, 5) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'social-upgrades', version: 1, createdAt: Date.now(),
  })
  return { severity, recommendedActions: actions }
}

// ─── Influencer discovery (record + outreach plan) ──────────────────────

export async function recordInfluencerCandidate(input: { workspaceId: string; platform: Platform; handle: string; niche: string; followerCount: number; engagementRate?: number; estimatedReach?: number; notes?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'influencer.candidate_added', workspaceId: input.workspaceId,
    payload: { id, platform: input.platform, handle: input.handle.slice(0, 100), niche: input.niche.slice(0, 100), followerCount: input.followerCount, engagementRate: input.engagementRate ?? null, estimatedReach: input.estimatedReach ?? null, notes: (input.notes ?? '').slice(0, 500), tier: tierOf(input.followerCount) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'social-upgrades', version: 1, createdAt: Date.now(),
  })
  return { id }
}

function tierOf(n: number): string {
  if (n < 10_000) return 'nano'
  if (n < 100_000) return 'micro'
  if (n < 1_000_000) return 'mid'
  return 'macro'
}

export function influencerOutreachTemplate(input: { tier: 'nano' | 'micro' | 'mid' | 'macro'; offer: 'free-product' | 'flat-fee' | 'rev-share' | 'affiliate' }): { subject: string; body: string } {
  const subject = input.tier === 'macro' ? 'Partnership opportunity' : 'Loved your recent work — quick idea'
  const body = `Hi — I came across your content and the work you do in this niche resonates with our brand. We'd love to explore a ${input.offer.replace('-', ' ')} collaboration if it fits your audience. Open to a quick reply with what works for you?`
  return { subject, body }
}
