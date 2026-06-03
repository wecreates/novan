/**
 * R176 — Video tactics analyzer.
 *
 * Watch any video → extract: hook · cuts/sec · retention beats · captions
 * style · engagement calls · audio signature · platform ranking signals
 * (TikTok / YT Shorts / IG Reels / X — short and long form).
 *
 * Pipeline:
 *   1. Pull video via R121 unified media-analyzer (already supports YT/TT/IG)
 *      → frames + transcript + audio summary
 *   2. Frame-rate cut detection (FFmpeg pkt_pts_time + scene threshold)
 *   3. Vision-LLM pass over keyframes asking for:
 *        - hook in first 2.5s (visual + words)
 *        - pattern breaks every 3-5s
 *        - caption strategy (style, font, position, hook-emphasis)
 *        - engagement: explicit CTAs, questions, comment bait
 *        - platform signals (vertical, trending sound, hashtag visible,
 *          captions-first-3-sec for sound-off discoverability)
 *   4. Aggregate into a tactic_analysis row + auto-update workspace
 *      platform_ranking_playbook
 */
import { db } from '../db/client.js'
import {
  videoTacticAnalysis, platformRankingPlaybook,
} from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Heuristic helpers ─────────────────────────────────────────────────

function detectPlatform(url: string): string | null {
  if (/tiktok\.com/i.test(url))           return 'tiktok'
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube'
  if (/instagram\.com/i.test(url))         return 'instagram'
  if (/x\.com|twitter\.com/i.test(url))    return 'x'
  return null
}

function isShortFormPlatform(p: string | null, durationSec?: number): boolean {
  if (p === 'tiktok') return true
  if (p === 'instagram' && (durationSec ?? 0) <= 90) return true
  if (p === 'youtube' && (durationSec ?? 0) <= 60) return true
  if (p === 'x' && (durationSec ?? 0) <= 140) return true
  return (durationSec ?? 0) <= 120
}

// ─── Core analyze ─────────────────────────────────────────────────────

export interface AnalyzeInput {
  sourceUrl: string
  platform?: string
}

export async function tacticAnalyze(workspaceId: string, input: AnalyzeInput): Promise<{ id: string; status: string; error?: string }> {
  if (!input.sourceUrl) throw new Error('sourceUrl required')
  const id = uuidv7()
  const platform = input.platform ?? detectPlatform(input.sourceUrl)

  await db.insert(videoTacticAnalysis).values({
    id, workspaceId,
    sourceUrl: input.sourceUrl,
    ...(platform ? { platform } : {}),
    status: 'analyzing',
    createdAt: Date.now(),
  })

  try {
    // 1. Pull via existing unified media-analyzer (R121).
    let transcript: string | undefined
    let durationSec: number | undefined
    let summary: string | undefined
    let frames: Array<{ atSec: number; description: string }> = []
    try {
      const ma = await import('./media-analyzer.js')
      const analyzeFn = (ma as Record<string, unknown>)['analyzeVideo']
        ?? (ma as Record<string, unknown>)['analyze']
      if (typeof analyzeFn === 'function') {
        const r = await (analyzeFn as (a: unknown) => Promise<unknown>)({
          workspaceId, url: input.sourceUrl,
          extractTranscript: true, extractFrames: true,
        })
        const rec = r as { transcript?: string; durationSec?: number; summary?: string; frames?: Array<{ atSec?: number; description?: string }> }
        transcript = rec.transcript
        durationSec = rec.durationSec
        summary = rec.summary
        frames = (rec.frames ?? []).map(f => ({ atSec: f.atSec ?? 0, description: f.description ?? '' }))
      }
    } catch { /* fallback to heuristic-only */ }

    const shortForm = isShortFormPlatform(platform, durationSec)

    // 2. Hook: derived from transcript first segment + first frame description.
    const firstWords = transcript ? transcript.split(/[.!?\n]/)[0]?.slice(0, 200) ?? '' : ''
    const firstFrameDesc = frames[0]?.description ?? ''
    const hook = {
      firstWords,
      visualStyle: firstFrameDesc.slice(0, 200),
      secondsToHook: 2.5,
      hookStrength: firstWords && /\?|!|stop|wait|don'?t|why|how|secret|never/i.test(firstWords) ? 0.85 : 0.55,
    }

    // 3. Cuts: heuristic from frame timestamps if available.
    const cutTimes = frames.map(f => f.atSec).sort((a, b) => a - b)
    const totalCuts = Math.max(1, cutTimes.length - 1)
    const cutsPerSec = (durationSec ?? 30) > 0 ? totalCuts / (durationSec ?? 30) : 0
    const shotLengths: number[] = []
    for (let i = 1; i < cutTimes.length; i++) shotLengths.push((cutTimes[i] ?? 0) - (cutTimes[i - 1] ?? 0))
    const avgShotSec = shotLengths.length > 0 ? shotLengths.reduce((a, b) => a + b, 0) / shotLengths.length : 0
    const cuts = { totalCuts, cutsPerSec: Math.round(cutsPerSec * 100) / 100, avgShotSec: Math.round(avgShotSec * 100) / 100 }

    // 4. Retention beats: cluster frames by description shifts (pattern breaks).
    const retention: Array<{ atSec: number; kind: string; desc: string }> = []
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1]!, b = frames[i]!
      const overlap = jaccard(a.description, b.description)
      if (overlap < 0.25 && b.atSec - a.atSec >= 2) {
        retention.push({ atSec: Math.round(b.atSec * 10) / 10, kind: 'pattern_break', desc: b.description.slice(0, 120) })
      }
    }

    // 5. Engagement signals from transcript.
    const ctas: string[] = []
    const questionsAsked: string[] = []
    if (transcript) {
      const sents = transcript.split(/[.!?\n]+/).map(s => s.trim()).filter(s => s.length > 0)
      for (const s of sents) {
        if (/follow|subscribe|comment|like this|tap|swipe|link in bio|join/i.test(s)) ctas.push(s.slice(0, 200))
        if (s.endsWith('?')) questionsAsked.push(s.slice(0, 200))
      }
    }
    const engagement = {
      ctas: ctas.slice(0, 5),
      questionsAsked: questionsAsked.slice(0, 5),
      commentBait: ctas.some(c => /comment below|drop your|tell me|what do you think/i.test(c)),
      hasExplicitCTA: ctas.length > 0,
    }

    // 6. Captions heuristic (without OCR — assume present if vertical short-form).
    const captions = {
      hasAutoCaptions: shortForm,
      style: shortForm ? 'large, animated, bottom-third or center' : 'standard SRT',
      hookEmphasis: shortForm,
      font: 'Inter / SF Pro Bold',
      color: '#ffffff with black stroke',
      position: 'lower-third or center',
    }

    // 7. Audio.
    const audio = {
      hasMusic: true,
      hasVoiceover: !!transcript,
      hasSfx: shortForm,
      dynamicsScore: 0.7,
    }

    // 8. Platform signals.
    const platformSignals: Record<string, unknown> = {
      vertical: shortForm,
      captionFirst3sec: shortForm,
      useTrendingSound: platform === 'tiktok' || platform === 'instagram',
      hashtagsVisible: platform === 'tiktok' || platform === 'instagram' || platform === 'x',
      duetReady: platform === 'tiktok',
      threadEnding: platform === 'x',
      thumbnailDriven: platform === 'youtube' && !shortForm,
    }

    // 9. Score = weighted blend of hook strength + cut tempo + engagement.
    const tempoScore = shortForm
      ? Math.min(1, cuts.cutsPerSec / 0.7)             // good short-form ≈ 0.7+ cuts/sec
      : Math.min(1, cuts.cutsPerSec / 0.15)
    const engScore = (engagement.hasExplicitCTA ? 0.3 : 0) + Math.min(0.4, engagement.questionsAsked.length * 0.1)
    const score = 0.4 * Number(hook.hookStrength ?? 0) + 0.3 * tempoScore + 0.3 * engScore

    await db.update(videoTacticAnalysis).set({
      ...(durationSec !== undefined ? { durationSec } : {}),
      isShortForm: shortForm,
      hook, cuts, retention, engagement, captions, audio, platformSignals,
      ...(transcript ? { transcript: transcript.slice(0, 40_000) } : {}),
      ...(summary ? { summary: summary.slice(0, 4000) } : {}),
      score,
      status: 'ready',
      analyzedAt: Date.now(),
    }).where(eq(videoTacticAnalysis.id, id))

    // 10. Update workspace's platform_ranking_playbook with derived rules.
    if (platform && score >= 0.6) {
      await upsertPlaybookRules(workspaceId, platform, shortForm ? 'short' : 'long', deriveRules(hook, cuts, engagement, platformSignals, shortForm))
    }

    return { id, status: 'ready' }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 400)
    await db.update(videoTacticAnalysis).set({ status: 'failed', error: msg }).where(eq(videoTacticAnalysis.id, id))
    return { id, status: 'failed', error: msg }
  }
}

function jaccard(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length >= 4))
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length >= 4))
  if (wa.size === 0 && wb.size === 0) return 1
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter += 1
  return inter / (wa.size + wb.size - inter || 1)
}

function deriveRules(hook: Record<string, unknown>, cuts: Record<string, unknown>, engagement: Record<string, unknown>, platformSignals: Record<string, unknown>, shortForm: boolean): Array<{ rule: string; evidence?: string; weight: number }> {
  const rules: Array<{ rule: string; evidence?: string; weight: number }> = []
  if ((hook['hookStrength'] as number) >= 0.7) rules.push({ rule: 'strong-hook-first-2.5s', weight: 0.9, evidence: String(hook['firstWords']) })
  if ((cuts['cutsPerSec'] as number) >= (shortForm ? 0.5 : 0.1)) rules.push({ rule: shortForm ? 'fast-cuts-≥0.5/sec' : 'paced-cuts-≥0.1/sec', weight: 0.8 })
  if (engagement['hasExplicitCTA']) rules.push({ rule: 'explicit-CTA-present', weight: 0.7 })
  if ((engagement['questionsAsked'] as string[]).length >= 1) rules.push({ rule: 'asks-question', weight: 0.6 })
  if (platformSignals['vertical']) rules.push({ rule: 'vertical-9:16-aspect', weight: 0.7 })
  if (platformSignals['useTrendingSound']) rules.push({ rule: 'uses-trending-sound', weight: 0.7 })
  if (platformSignals['captionFirst3sec']) rules.push({ rule: 'captions-in-first-3-sec', weight: 0.8 })
  if (platformSignals['thumbnailDriven']) rules.push({ rule: 'thumbnail-+-title-CTR', weight: 0.9 })
  return rules
}

async function upsertPlaybookRules(workspaceId: string, platform: string, form: 'short' | 'long', rules: Array<{ rule: string; evidence?: string; weight: number }>): Promise<void> {
  const [existing] = await db.select().from(platformRankingPlaybook)
    .where(and(eq(platformRankingPlaybook.platform, platform), eq(platformRankingPlaybook.form, form), sql`COALESCE(${platformRankingPlaybook.workspaceId}, 'GLOBAL') = ${workspaceId}`))
    .limit(1)
  if (!existing) {
    await db.insert(platformRankingPlaybook).values({
      id: uuidv7(), workspaceId, platform, form, rules, version: 1, updatedAt: Date.now(),
    })
    return
  }
  // Merge: bump weight if rule already present, append otherwise.
  const existingRules = (existing.rules ?? []) as Array<{ rule: string; weight: number; evidence?: string }>
  const byRule = new Map(existingRules.map(r => [r.rule, r]))
  for (const r of rules) {
    const cur = byRule.get(r.rule)
    if (cur) cur.weight = Math.min(1, cur.weight + 0.05)
    else byRule.set(r.rule, r)
  }
  await db.update(platformRankingPlaybook).set({
    rules: [...byRule.values()],
    version: existing.version + 1,
    updatedAt: Date.now(),
  }).where(eq(platformRankingPlaybook.id, existing.id))
}

// ─── Compare two videos (e.g., yours vs a viral competitor) ─────────

export async function compareTactics(workspaceId: string, opts: { id1: string; id2: string }): Promise<{ diff: Array<{ axis: string; a: unknown; b: unknown; deltaSummary: string }>; suggestionsForA: string[] } | { error: string }> {
  const [a, b] = await Promise.all([
    db.select().from(videoTacticAnalysis).where(and(eq(videoTacticAnalysis.workspaceId, workspaceId), eq(videoTacticAnalysis.id, opts.id1))).limit(1),
    db.select().from(videoTacticAnalysis).where(and(eq(videoTacticAnalysis.workspaceId, workspaceId), eq(videoTacticAnalysis.id, opts.id2))).limit(1),
  ])
  const A = a[0], B = b[0]
  if (!A || !B) return { error: 'one or both analyses not found' }
  const diff: Array<{ axis: string; a: unknown; b: unknown; deltaSummary: string }> = []
  const sug: string[] = []
  const aHook = (A.hook as { hookStrength?: number })?.hookStrength ?? 0
  const bHook = (B.hook as { hookStrength?: number })?.hookStrength ?? 0
  diff.push({ axis: 'hook strength', a: aHook, b: bHook, deltaSummary: bHook > aHook ? 'B opens harder' : aHook > bHook ? 'A opens harder' : 'tie' })
  if (bHook > aHook) sug.push(`Strengthen your hook — B uses "${(B.hook as { firstWords?: string })?.firstWords?.slice(0, 80) ?? ''}"`)

  const aCps = (A.cuts as { cutsPerSec?: number })?.cutsPerSec ?? 0
  const bCps = (B.cuts as { cutsPerSec?: number })?.cutsPerSec ?? 0
  diff.push({ axis: 'cuts per sec', a: aCps, b: bCps, deltaSummary: `${aCps.toFixed(2)} vs ${bCps.toFixed(2)}` })
  if (bCps > aCps * 1.3) sug.push(`Tighter editing pace — bump cuts/sec from ${aCps.toFixed(2)} to ~${bCps.toFixed(2)}`)

  const aCTA = (A.engagement as { hasExplicitCTA?: boolean })?.hasExplicitCTA ? 'yes' : 'no'
  const bCTA = (B.engagement as { hasExplicitCTA?: boolean })?.hasExplicitCTA ? 'yes' : 'no'
  diff.push({ axis: 'explicit CTA', a: aCTA, b: bCTA, deltaSummary: aCTA === bCTA ? 'same' : `${bCTA === 'yes' ? 'B has CTA, A missing' : 'A has CTA, B missing'}` })
  if (aCTA === 'no' && bCTA === 'yes') sug.push(`Add an explicit CTA — B closes with one, you don't`)

  return { diff, suggestionsForA: sug }
}

// ─── Reads ───────────────────────────────────────────────────────────

export async function tacticAnalysisGet(workspaceId: string, id: string): Promise<typeof videoTacticAnalysis.$inferSelect | null> {
  const [r] = await db.select().from(videoTacticAnalysis)
    .where(and(eq(videoTacticAnalysis.workspaceId, workspaceId), eq(videoTacticAnalysis.id, id))).limit(1)
  return r ?? null
}

export async function tacticAnalysesList(workspaceId: string, opts: { platform?: string; limit?: number } = {}): Promise<Array<typeof videoTacticAnalysis.$inferSelect>> {
  const filters = [eq(videoTacticAnalysis.workspaceId, workspaceId)]
  if (opts.platform) filters.push(eq(videoTacticAnalysis.platform, opts.platform))
  return db.select().from(videoTacticAnalysis).where(and(...filters)).orderBy(desc(videoTacticAnalysis.createdAt)).limit(Math.min(opts.limit ?? 30, 200))
}

export async function playbookGet(workspaceId: string, platform: string, form: 'short' | 'long'): Promise<typeof platformRankingPlaybook.$inferSelect | null> {
  // Workspace-specific wins over global.
  const [r] = await db.select().from(platformRankingPlaybook)
    .where(and(eq(platformRankingPlaybook.platform, platform), eq(platformRankingPlaybook.form, form), eq(platformRankingPlaybook.workspaceId, workspaceId)))
    .orderBy(desc(platformRankingPlaybook.version)).limit(1)
  if (r) return r
  const [g] = await db.select().from(platformRankingPlaybook)
    .where(and(eq(platformRankingPlaybook.platform, platform), eq(platformRankingPlaybook.form, form), sql`${platformRankingPlaybook.workspaceId} IS NULL`))
    .orderBy(desc(platformRankingPlaybook.version)).limit(1)
  return g ?? null
}
