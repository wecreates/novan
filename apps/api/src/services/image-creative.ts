/**
 * image-creative.ts — DB-backed wrapper around the pure scoring engine
 * in image-quality.ts.
 *
 *   - reviewGeneration(id)        : pull a generation, run scoreGeneration,
 *                                   write an image_quality_reviews row,
 *                                   stamp the *_score columns on the
 *                                   generation, return the verdict.
 *   - reviewBatch(workspaceId, n) : re-score the most recent N
 *                                   generations that lack a review. Used
 *                                   by the war-room creative tile and a
 *                                   future periodic sweep.
 *   - creativeMetrics(workspaceId): rollup for the war-room creative
 *                                   view (quality / slop / originality
 *                                   trends, top styles, rejection rate).
 */
import { db } from '../db/client.js'
import { imageGenerations, imageQualityReviews, events } from '../db/schema.js'
import { and, eq, gte, desc, isNull, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { scoreGeneration, isPromptUnsafe, antiSlopRewrite, premiumRewrite, type GenerationVerdict } from './image-quality.js'

export async function reviewGeneration(workspaceId: string, generationId: string, reviewer?: string): Promise<GenerationVerdict | null> {
  const gen = await db.select().from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), eq(imageGenerations.id, generationId)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[image-creative]', e.message); return null })
  if (!gen) return null

  const verdict = scoreGeneration({
    prompt:          gen.prompt,
    enhancedPrompt:  gen.enhancedPrompt,
    stylePreset:     gen.stylePreset,
    brandCategory:   gen.brandCategory,
    userRating:      gen.userRating,
    provider:        gen.provider,
    latencyMs:       gen.latencyMs,
  })

  const id = uuidv7()
  await db.insert(imageQualityReviews).values({
    id, workspaceId, generationId,
    kind:         reviewer ? 'operator' : 'auto',
    verdict:      verdict.shouldReject ? 'reject' : verdict.shouldFlag ? 'flag' : 'approve',
    composite:    verdict.composite,
    qualityScore: verdict.promptScore.qualityScore,
    slopRisk:     verdict.promptScore.slopRisk,
    originality:  verdict.promptScore.originalityScore,
    composition:  verdict.promptScore.compositionScore,
    brandFit:     verdict.promptScore.brandFitScore,
    reasons:      [...verdict.reasons, ...verdict.promptScore.flags],
    reviewer:     reviewer ?? null,
    createdAt:    Date.now(),
  }).catch((e: Error) => { console.error('[image-creative]', e.message); return null })

  await db.update(imageGenerations).set({
    qualityScore:     Number(verdict.composite.toFixed(3)),
    slopRiskScore:    Number(verdict.promptScore.slopRisk.toFixed(3)),
    originalityScore: Number(verdict.promptScore.originalityScore.toFixed(3)),
    compositionScore: Number(verdict.promptScore.compositionScore.toFixed(3)),
    brandFitScore:    Number(verdict.promptScore.brandFitScore.toFixed(3)),
    creativeFlags:    verdict.promptScore.flags,
  }).where(eq(imageGenerations.id, generationId)).catch((e: Error) => { console.error('[image-creative]', e.message); return null })

  await db.insert(events).values({
    id: uuidv7(), type: `image.creative.${verdict.shouldReject ? 'rejected' : verdict.shouldFlag ? 'flagged' : 'approved'}`,
    workspaceId, payload: { generationId, composite: verdict.composite, flags: verdict.promptScore.flags },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/image-creative', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[image-creative]', e.message); return null })

  return verdict
}

export async function reviewBatch(workspaceId: string, limit = 50): Promise<{ reviewed: number; rejected: number; flagged: number }> {
  const rows = await db.select({ id: imageGenerations.id, hasScore: imageGenerations.slopRiskScore })
    .from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), isNull(imageGenerations.slopRiskScore)))
    .orderBy(desc(imageGenerations.createdAt))
    .limit(limit).catch(() => [])
  let rejected = 0, flagged = 0
  for (const r of rows) {
    const v = await reviewGeneration(workspaceId, r.id).catch((e: Error) => { console.error('[image-creative]', e.message); return null })
    if (!v) continue
    if (v.shouldReject) rejected++
    else if (v.shouldFlag) flagged++
  }
  return { reviewed: rows.length, rejected, flagged }
}

export interface CreativeMetrics {
  windowMs:          number
  totalGenerations:  number
  avgQuality:        number | null
  avgSlopRisk:       number | null
  avgOriginality:    number | null
  rejectRate:        number
  flagRate:          number
  topStyles:         Array<{ style: string; count: number; avgQuality: number }>
  topBrandCategories:Array<{ category: string; count: number }>
  providerHealth:    Array<{ provider: string; samples: number; successRate: number; avgLatency: number; avgQuality: number }>
  recentFlags:       string[]
}

export async function creativeMetrics(workspaceId: string, opts: { windowMs?: number } = {}): Promise<CreativeMetrics> {
  const windowMs = opts.windowMs ?? 7 * 86_400_000
  const since = Date.now() - windowMs

  const gens = await db.select().from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, since)))
    .limit(5000).catch(() => [])
  const reviews = await db.select().from(imageQualityReviews)
    .where(and(eq(imageQualityReviews.workspaceId, workspaceId), gte(imageQualityReviews.createdAt, since)))
    .limit(5000).catch(() => [])

  const ratings: number[] = []
  const slops:    number[] = []
  const origs:    number[] = []
  const flagSet  = new Set<string>()
  const stylesCounts = new Map<string, { count: number; quality: number }>()
  const brandCounts  = new Map<string, number>()
  const provStats    = new Map<string, { samples: number; ok: number; latencySum: number; latencyN: number; qualitySum: number; qualityN: number }>()

  for (const g of gens) {
    if (typeof g.qualityScore     === 'number') ratings.push(g.qualityScore)
    if (typeof g.slopRiskScore    === 'number') slops.push(g.slopRiskScore)
    if (typeof g.originalityScore === 'number') origs.push(g.originalityScore)
    for (const f of (g.creativeFlags as string[] | null) ?? []) flagSet.add(f)
    if (g.stylePreset) {
      const e = stylesCounts.get(g.stylePreset) ?? { count: 0, quality: 0 }
      e.count++
      e.quality += g.qualityScore ?? 0
      stylesCounts.set(g.stylePreset, e)
    }
    if (g.brandCategory) brandCounts.set(g.brandCategory, (brandCounts.get(g.brandCategory) ?? 0) + 1)
    const p = provStats.get(g.provider) ?? { samples: 0, ok: 0, latencySum: 0, latencyN: 0, qualitySum: 0, qualityN: 0 }
    p.samples++
    if (g.status === 'succeeded') p.ok++
    if (typeof g.latencyMs === 'number')    { p.latencySum += g.latencyMs; p.latencyN++ }
    if (typeof g.qualityScore === 'number') { p.qualitySum += g.qualityScore; p.qualityN++ }
    provStats.set(g.provider, p)
  }

  const rejected = reviews.filter(r => r.verdict === 'reject').length
  const flagged  = reviews.filter(r => r.verdict === 'flag').length
  const total    = reviews.length || gens.length

  const avg = (xs: number[]) => xs.length === 0 ? null : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3))

  return {
    windowMs,
    totalGenerations:   gens.length,
    avgQuality:         avg(ratings),
    avgSlopRisk:        avg(slops),
    avgOriginality:     avg(origs),
    rejectRate:         total === 0 ? 0 : Number((rejected / total).toFixed(3)),
    flagRate:           total === 0 ? 0 : Number((flagged / total).toFixed(3)),
    topStyles: [...stylesCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10)
                  .map(([style, e]) => ({ style, count: e.count, avgQuality: e.count === 0 ? 0 : Number((e.quality / e.count).toFixed(3)) })),
    topBrandCategories: [...brandCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                  .map(([category, count]) => ({ category, count })),
    providerHealth: [...provStats.entries()].map(([provider, p]) => ({
      provider, samples: p.samples,
      successRate: p.samples === 0 ? 0 : Number((p.ok / p.samples).toFixed(3)),
      avgLatency:  p.latencyN === 0 ? 0 : Math.round(p.latencySum / p.latencyN),
      avgQuality:  p.qualityN === 0 ? 0 : Number((p.qualitySum / p.qualityN).toFixed(3)),
    })).sort((a, b) => b.samples - a.samples),
    recentFlags: [...flagSet].slice(0, 30),
  }
}

// ─── Prompt enhancement endpoints (pure wrappers) ───────────────────────

export function safetyCheck(prompt: string) {
  // Increment counter via SQL only when the table exists; for now just call the pure function
  void sql
  return isPromptUnsafe(prompt)
}

export function improvePrompt(prompt: string): { prompt: string; removed: string[]; added: string[] } {
  return antiSlopRewrite(prompt)
}

export function makePromptPremium(prompt: string): { prompt: string; added: string[] } {
  return premiumRewrite(prompt)
}
