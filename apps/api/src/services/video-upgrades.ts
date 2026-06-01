/**
 * video-upgrades.ts — R146.91 — video system gaps:
 *  b-roll match, retention curve, first-3-seconds per platform,
 *  trend tracking, thumbnail A/B, multi-language relocalization,
 *  multi-shot continuity (reference-conditioning stub).
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── B-roll auto-match to script beats ─────────────────────────────────────

export async function matchBrollToScript(input: { workspaceId: string; scriptBeats: Array<{ beatId: string; text: string; durationSec: number; mood?: string }> }): Promise<{
  matches: Array<{ beatId: string; query: string; rationale: string; suggestedSource: 'pexels' | 'pixabay' | 'unsplash' | 'generated' }>
}> {
  const matches = input.scriptBeats.map(b => {
    const moods = (b.mood ?? '').toLowerCase()
    const keywords = b.text.toLowerCase().split(/\W+/).filter(w => w.length >= 4).slice(0, 5)
    const query = [...keywords, moods].filter(Boolean).join(' ').slice(0, 80) || b.text.slice(0, 40)
    const source: 'pexels' | 'pixabay' | 'unsplash' | 'generated' = b.durationSec >= 5 ? 'pexels' : moods.includes('abstract') ? 'generated' : 'pexels'
    return { beatId: b.beatId, query, rationale: `keywords from beat text + mood "${b.mood ?? 'neutral'}" → ${source}`, suggestedSource: source }
  })
  await db.insert(events).values({
    id: uuidv7(), type: 'video.broll_matched', workspaceId: input.workspaceId,
    payload: { beatCount: input.scriptBeats.length, matches: matches.slice(0, 20) },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'video-upgrades', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return { matches }
}

// ─── Retention curve analysis ─────────────────────────────────────────────

export async function analyzeRetentionCurve(input: { workspaceId: string; videoId: string; platform: 'youtube' | 'tiktok' | 'instagram'; bucketRetentionPct: number[]; bucketSeconds: number[] }): Promise<{
  dropoffPoints: Array<{ atSec: number; dropoffPct: number; severity: 'minor' | 'major' | 'cliff' }>
  recommendation: string
}> {
  const points: Array<{ atSec: number; dropoffPct: number; severity: 'minor' | 'major' | 'cliff' }> = []
  for (let i = 1; i < input.bucketRetentionPct.length; i++) {
    const drop = (input.bucketRetentionPct[i - 1] ?? 0) - (input.bucketRetentionPct[i] ?? 0)
    if (drop < 5) continue
    const sev: 'minor' | 'major' | 'cliff' = drop >= 25 ? 'cliff' : drop >= 12 ? 'major' : 'minor'
    points.push({ atSec: input.bucketSeconds[i] ?? 0, dropoffPct: drop, severity: sev })
  }
  let rec = 'curve looks healthy — no major dropoffs'
  const firstCliff = points.find(p => p.severity === 'cliff' && p.atSec < 15)
  const lateCliff  = points.find(p => p.severity === 'cliff' && p.atSec >= 15)
  if (firstCliff) rec = `${firstCliff.dropoffPct.toFixed(0)}% drop at ${firstCliff.atSec}s — hook is weak; reshoot first 3-5 seconds`
  else if (lateCliff) rec = `cliff at ${lateCliff.atSec}s — likely topic shift or pacing dip; tighten that section`
  await db.insert(events).values({
    id: uuidv7(), type: 'video.retention_analyzed', workspaceId: input.workspaceId,
    payload: { videoId: input.videoId, platform: input.platform, dropoffCount: points.length, recommendation: rec },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'video-upgrades', version: 1, createdAt: Date.now(),
  }).catch(() => null)
  return { dropoffPoints: points, recommendation: rec }
}

// ─── First-3-seconds per platform ─────────────────────────────────────────

export function platformHookGuide(platform: 'youtube-long' | 'youtube-short' | 'tiktok' | 'instagram-reel' | 'instagram-feed'): {
  optimalLengthSec: number
  hookPattern: string
  forbidden: string[]
} {
  switch (platform) {
    case 'youtube-long':    return { optimalLengthSec: 8,  hookPattern: 'state the outcome the viewer gets — answer "what will I learn"',                forbidden: ['logo intro', 'channel-name greeting'] }
    case 'youtube-short':   return { optimalLengthSec: 2,  hookPattern: 'visual disruption + question — must work without audio',                       forbidden: ['intro card', 'slow zoom', 'silence'] }
    case 'tiktok':          return { optimalLengthSec: 1.5, hookPattern: 'pattern-interrupt visual + spoken hook in <2s',                                 forbidden: ['logo', 'fade-in', 'long establishing shot'] }
    case 'instagram-reel':  return { optimalLengthSec: 1.5, hookPattern: 'face-to-camera or motion in first frame; text overlay restates hook',         forbidden: ['logo intro', 'static title card'] }
    case 'instagram-feed':  return { optimalLengthSec: 3,  hookPattern: 'striking still frame + first-line caption hook',                                forbidden: ['low-contrast hero', 'centered logo'] }
  }
}

// ─── Trend tracking ─────────────────────────────────────────────────────

export async function recordTrendObservation(input: { workspaceId: string; platform: string; trendKind: 'sound' | 'format' | 'hook' | 'effect'; descriptor: string; engagementSignal?: number; expiresInDays?: number }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(events).values({
    id: uuidv7(), type: 'video.trend_observed', workspaceId: input.workspaceId,
    payload: { id, platform: input.platform, trendKind: input.trendKind, descriptor: input.descriptor.slice(0, 300), engagementSignal: input.engagementSignal ?? null, expiresAt: input.expiresInDays ? Date.now() + input.expiresInDays * 86_400_000 : null, observedAt: Date.now() },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'video-upgrades', version: 1, createdAt: Date.now(),
  })
  return { id }
}

export async function listActiveTrends(workspaceId: string, platform?: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'video.trend_observed'),
               gte(events.createdAt, Date.now() - 30 * 86_400_000)))
    .orderBy(desc(events.createdAt)).limit(200)
  const trends = rows.map(r => r.payload as Record<string, unknown>)
  return trends.filter(t => {
    if (platform && t['platform'] !== platform) return false
    const exp = t['expiresAt'] as number | null
    return !exp || exp > Date.now()
  })
}

// ─── Thumbnail A/B (record + decide) ───────────────────────────────────────

export async function recordThumbnailExposure(input: { workspaceId: string; videoId: string; variant: string; impressions: number; clicks: number }): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type: 'video.thumbnail_exposure', workspaceId: input.workspaceId,
    payload: { videoId: input.videoId, variant: input.variant, impressions: input.impressions, clicks: input.clicks, ctr: input.impressions > 0 ? input.clicks / input.impressions : 0 },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'video-upgrades', version: 1, createdAt: Date.now(),
  })
}

export async function thumbnailAbWinner(workspaceId: string, videoId: string): Promise<{ winner: string | null; results: Array<{ variant: string; impressions: number; clicks: number; ctr: number }> }> {
  const rows = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'video.thumbnail_exposure'),
               sql`payload->>'videoId' = ${videoId}`))
    .limit(200)
  const agg: Record<string, { impressions: number; clicks: number }> = {}
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>
    const v = (p['variant'] as string) ?? 'unknown'
    if (!agg[v]) agg[v] = { impressions: 0, clicks: 0 }
    agg[v].impressions += Number(p['impressions'] ?? 0)
    agg[v].clicks      += Number(p['clicks'] ?? 0)
  }
  const results = Object.entries(agg).map(([variant, v]) => ({ variant, ...v, ctr: v.impressions > 0 ? v.clicks / v.impressions : 0 }))
  results.sort((a, b) => b.ctr - a.ctr)
  return { winner: results[0]?.variant ?? null, results }
}

// ─── Multi-language relocalization (plan only — actual TTS lives in voice-service) ───

export function planRelocalization(input: { sourceLanguage: string; targetLanguages: string[]; durationSec: number }): {
  targets: Array<{ language: string; tasks: string[]; estimatedMinutes: number }>
  totalEstimatedMinutes: number
} {
  const targets = input.targetLanguages.map(lang => ({
    language: lang,
    tasks: [
      `translate script (src=${input.sourceLanguage})`,
      `voice-clone TTS in ${lang}`,
      `burn captions in ${lang}`,
      `rewrite title + description + tags for ${lang}`,
      `regenerate thumbnail text overlay for ${lang}`,
    ],
    estimatedMinutes: Math.ceil(input.durationSec * 0.5) + 5,
  }))
  return { targets, totalEstimatedMinutes: targets.reduce((s, t) => s + t.estimatedMinutes, 0) }
}

// ─── Multi-shot continuity (reference plan) ──────────────────────────────

export function planMultiShotContinuity(input: { shotCount: number; characterRefs?: string[]; sceneRefs?: string[] }): {
  strategy: string
  perShot: Array<{ shotIdx: number; conditioning: string[] }>
} {
  const charRefs  = input.characterRefs ?? []
  const sceneRefs = input.sceneRefs ?? []
  const perShot = Array.from({ length: input.shotCount }, (_, i) => ({
    shotIdx: i,
    conditioning: [
      ...charRefs.map(r => `character-ref:${r}`),
      ...sceneRefs.map(r => `scene-ref:${r}`),
      i === 0 ? 'establishing-shot' : `prev-shot-frame:${i - 1}`,
    ],
  }))
  return {
    strategy: `IP-Adapter / ref-image conditioning per shot with prev-shot last frame anchor. Char refs: ${charRefs.length}, scene refs: ${sceneRefs.length}.`,
    perShot,
  }
}
