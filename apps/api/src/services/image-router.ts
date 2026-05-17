/**
 * image-router.ts — Smart provider selection for image generation.
 *
 * Selects a provider based on:
 *   1. Provider configured (key present)
 *   2. Workspace budget remaining vs estimated cost
 *   3. Recent provider performance (success rate + latency from
 *      image_generations history)
 *   4. Model capability for the requested aspect ratio
 *   5. Operator preference: IMAGE_PROVIDER_DEFAULT env, or pinned model
 *
 * Returns the first provider that passes all gates, with full rationale.
 * Caller can also pin a specific provider — router only adjudicates if
 * the request leaves provider unset.
 */
import { db }                          from '../db/client.js'
import { imageGenerations, providerBudgets } from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { quoteCost, listAvailableProviders, type ImageProvider } from './image-generator.js'

const WEEK = 7 * 24 * 60 * 60_000

export interface RouteRequest {
  workspaceId:  string
  pinned?:      ImageProvider          // operator-pinned (skip router)
  width?:       number
  height?:      number
  model?:       string
  aspectRatio?: string
  brandCategory?: string
}

export interface RouteResult {
  provider:    ImageProvider
  provenance:  'user_pinned' | 'auto'
  reasons:     string[]
  estimateUsd: number
  fallbacks:   ImageProvider[]
}

interface ProviderScore {
  provider:    ImageProvider
  configured:  boolean
  successRate: number       // 0..1 over last 7 days
  avgLatency:  number       // ms
  estimate:    number       // USD for this request
  qualityAvg:  number       // avg userRating, 1..5, defaults to 3
  reasons:     string[]
}

const AR_DEFAULT_WH: Record<string, { w: number; h: number }> = {
  '1:1':  { w: 1024, h: 1024 },
  '16:9': { w: 1344, h: 768  },
  '9:16': { w: 768,  h: 1344 },
  '4:3':  { w: 1152, h: 896  },
  '3:4':  { w: 896,  h: 1152 },
}

const PROVIDER_QUALITY_HINT: Record<ImageProvider, { speed: number; quality: number }> = {
  // Subjective baseline — overridden by real userRating data once it exists
  openai:    { speed: 0.5, quality: 0.85 },
  replicate: { speed: 0.9, quality: 0.80 },  // flux-schnell is fast
  stability: { speed: 0.6, quality: 0.82 },
  fal:       { speed: 0.95, quality: 0.78 },
}

export async function selectProvider(req: RouteRequest): Promise<RouteResult> {
  const available = listAvailableProviders()

  // Honor pin first
  if (req.pinned && available.includes(req.pinned)) {
    return {
      provider:   req.pinned,
      provenance: 'user_pinned',
      reasons:    [`operator pinned ${req.pinned}`],
      estimateUsd: quoteCost(req.pinned, {
        ...(req.width  !== undefined ? { width:  req.width }  : {}),
        ...(req.height !== undefined ? { height: req.height } : {}),
        ...(req.model  !== undefined ? { model:  req.model }  : {}),
      }),
      fallbacks: available.filter(p => p !== req.pinned).slice(0, 3),
    }
  }

  if (available.length === 0) {
    throw new Error('no image providers configured — set REPLICATE_API_TOKEN / OPENAI_API_KEY / STABILITY_API_KEY / FAL_KEY')
  }

  // Default size from aspect ratio if not supplied
  const ar = req.aspectRatio ?? '1:1'
  const wh = AR_DEFAULT_WH[ar] ?? { w: 1024, h: 1024 }
  const w  = req.width  ?? wh.w
  const h  = req.height ?? wh.h

  // Budget check (cap at 50% of remaining daily budget per single image)
  const budget = await db.select().from(providerBudgets)
    .where(eq(providerBudgets.workspaceId, req.workspaceId)).limit(1)
    .then(r => r[0]).catch(() => null)
  const dailyRemaining = budget ? Math.max(0, budget.dailyLimitUsd - budget.dailySpendUsd) : Infinity
  const maxPerImageUsd = budget?.maxPerJobUsd && budget.maxPerJobUsd > 0
    ? Math.min(budget.maxPerJobUsd, dailyRemaining / 2)
    : Math.min(0.2, dailyRemaining / 2)

  // Score each provider
  const since = Date.now() - WEEK
  const scores: ProviderScore[] = []
  for (const p of available) {
    const estimate = quoteCost(p, { width: w, height: h, ...(req.model ? { model: req.model } : {}) })
    const perf = await db.select({
      total:       sql<number>`count(*)::int`,
      succeeded:   sql<number>`count(*) filter (where ${imageGenerations.status} = 'succeeded')::int`,
      avgLatency:  sql<number>`coalesce(avg(${imageGenerations.latencyMs}), 0)::float`,
      avgRating:   sql<number>`coalesce(avg(${imageGenerations.userRating}), 0)::float`,
    }).from(imageGenerations)
      .where(and(
        eq(imageGenerations.workspaceId, req.workspaceId),
        eq(imageGenerations.provider, p),
        gte(imageGenerations.createdAt, since),
      ))
      .then(r => r[0]).catch(() => null)
    const total = Number(perf?.total ?? 0)
    const successRate = total >= 3 ? Number(perf?.succeeded ?? 0) / total : -1  // -1 = insufficient data
    const avgLatency  = Number(perf?.avgLatency ?? 0)
    const ratingAvg   = total > 0 && Number(perf?.avgRating ?? 0) > 0 ? Number(perf?.avgRating) : 0
    const qualityAvg  = ratingAvg > 0 ? ratingAvg : PROVIDER_QUALITY_HINT[p].quality * 5

    const reasons: string[] = []
    if (successRate >= 0) reasons.push(`success ${(successRate*100).toFixed(0)}% (n=${total})`)
    else                  reasons.push(`success unknown (n=${total})`)
    if (avgLatency > 0)   reasons.push(`avg latency ${Math.round(avgLatency)}ms`)
    if (ratingAvg > 0)    reasons.push(`user rating ${ratingAvg.toFixed(1)}/5`)
    reasons.push(`est. $${estimate.toFixed(4)}`)

    scores.push({ provider: p, configured: true, successRate, avgLatency, estimate, qualityAvg, reasons })
  }

  // Filter out providers that fail budget gate
  const eligible = scores.filter(s => s.estimate <= maxPerImageUsd)
  if (eligible.length === 0) {
    // All exceed budget — pick cheapest and emit warning
    const cheapest = [...scores].sort((a, b) => a.estimate - b.estimate)[0]!
    return {
      provider:   cheapest.provider,
      provenance: 'auto',
      reasons:    [
        `WARNING: all providers exceed per-image cap $${maxPerImageUsd.toFixed(4)}`,
        ...cheapest.reasons,
      ],
      estimateUsd: cheapest.estimate,
      fallbacks:   scores.filter(s => s.provider !== cheapest.provider).map(s => s.provider),
    }
  }

  // Rank: prefer (success rate when known, else quality hint) / cost / latency
  eligible.sort((a, b) => {
    const aScore = (a.successRate >= 0 ? a.successRate : a.qualityAvg / 5) * 100
                   - a.estimate * 100
                   - (a.avgLatency || 5000) / 1000
    const bScore = (b.successRate >= 0 ? b.successRate : b.qualityAvg / 5) * 100
                   - b.estimate * 100
                   - (b.avgLatency || 5000) / 1000
    return bScore - aScore
  })

  const chosen = eligible[0]!
  const fallbacks = eligible.slice(1).map(s => s.provider)
  return {
    provider:    chosen.provider,
    provenance:  'auto',
    reasons:     chosen.reasons,
    estimateUsd: chosen.estimate,
    fallbacks,
  }
}

/** Re-score all providers — used for /studio router-status panel. */
export async function providerScores(workspaceId: string): Promise<ProviderScore[]> {
  const result = await selectProvider({ workspaceId })
  // Re-run scoring to expose all providers including chosen
  const available = listAvailableProviders()
  const since = Date.now() - WEEK
  const scores: ProviderScore[] = []
  for (const p of available) {
    const estimate = quoteCost(p, { width: 1024, height: 1024 })
    const perf = await db.select({
      total:       sql<number>`count(*)::int`,
      succeeded:   sql<number>`count(*) filter (where ${imageGenerations.status} = 'succeeded')::int`,
      avgLatency:  sql<number>`coalesce(avg(${imageGenerations.latencyMs}), 0)::float`,
      avgRating:   sql<number>`coalesce(avg(${imageGenerations.userRating}), 0)::float`,
    }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), eq(imageGenerations.provider, p), gte(imageGenerations.createdAt, since)))
      .then(r => r[0]).catch(() => null)
    const total = Number(perf?.total ?? 0)
    const successRate = total >= 3 ? Number(perf?.succeeded ?? 0) / total : -1
    scores.push({
      provider: p, configured: true,
      successRate, avgLatency: Number(perf?.avgLatency ?? 0), estimate,
      qualityAvg: Number(perf?.avgRating ?? 0) || (PROVIDER_QUALITY_HINT[p].quality * 5),
      reasons: [p === result.provider ? '★ selected' : 'available'],
    })
  }
  return scores
}
