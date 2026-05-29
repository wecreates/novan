/**
 * economic-engine.ts — real ROI / cash-flow / viability intelligence.
 *
 * Scores every workflow, automation, channel, and business by:
 *   • cost (provider tokens, infrastructure, time, GPU)
 *   • value (revenue proxy: views×RPM, conversions, subscribers gained)
 *   • leverage (compounding factor — does this make the next op cheaper?)
 *   • risk (variance in outcome)
 *
 * Pulls cost data from the production_log + memories (analytics) tables
 * already wired by content-analytics + production-log. Outputs ROI per
 * activity so the brain knows what compounds vs what wastes.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface EconomicScore {
  subject: string
  kind: 'workflow' | 'channel' | 'business' | 'automation'
  estimatedCostUsd: number
  estimatedValueUsd: number
  roi:        number    // value / max(cost, 0.01)
  leverage:   number    // 0..1; compounds = higher
  risk:       number    // 0..1; variance penalty
  score:      number    // combined ranking 0..100
  evidence:   string[]
}

// R146.5 — rates were stale relative to chat-providers.ts KNOWN_PROVIDERS
// (openai 33x too high, gemini 5x too high, groq 3x too low) which made
// `scorePublishedVideo` estimate production cost at ~$34/video when the
// real LLM spend is closer to $0.01. ROI rankings inverted: every video
// looked unprofitable, learning-cron's workspaceHealth surfaced wrong
// "biggest wastes", portfolio.improve picked wrong strategies.
// These match the input-rate side of KNOWN_PROVIDERS as of R146.4 — keep
// them in sync if pricing changes again (or factor into a shared module).
const TOKEN_COST = {
  // USD per 1k input tokens — input side only; production-cost estimate
  // for planning LLM calls (which are mostly input-bound prompts).
  openai:    0.000150,    // gpt-4o-mini  $0.15/MTok in
  anthropic: 0.003,       // sonnet-4-6   $3/MTok in
  gemini:    0.0003,      // 2.5-flash    $0.30/MTok in
  groq:      0.00059,     // llama-3.3-70b $0.59/MTok in
  elevenlabs: 0.30 / 1000,    // per char (PAYG tier rate)
} as const

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)) }

/**
 * Score a published video by analytics + estimated production cost.
 */
export async function scorePublishedVideo(workspaceId: string, videoId: string): Promise<EconomicScore | null> {
  // Look for analytics memory written by content-analytics.recordPerformance
  const rows = await db.execute(sql`
    SELECT content, confidence, tags FROM memories
    WHERE workspace_id = ${workspaceId}
      AND source = 'content-analytics'
      AND source_ref LIKE ${`%${videoId}%`}
    ORDER BY updated_at DESC LIMIT 1`)
  const row = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows?.[0]
  if (!row) return null

  // Parse "[platform] N views · M likes · X% CTR · Ys AVD · brief: …"
  const text = String(row['content'])
  const viewsMatch  = text.match(/(\d[\d,]*)\s+views/)
  const ctrMatch    = text.match(/([\d.]+)%\s+CTR/)
  const avdMatch    = text.match(/([\d.]+)s\s+AVD/)
  const platform    = text.match(/^\[(\w+)\]/)?.[1] ?? 'unknown'

  const views = viewsMatch ? Number(viewsMatch[1]!.replace(/,/g, '')) : 0
  const ctr   = ctrMatch ? Number(ctrMatch[1]) / 100 : 0
  const avd   = avdMatch ? Number(avdMatch[1]) : 0

  // RPM table (rough averages). Operator can override via env.
  // R144 — NaN-safe (bad env would make revenue projection always 0).
  const _rpm = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const rpm = platform === 'youtube' ? _rpm('YT_RPM_USD', 3.5)
            : platform === 'tiktok'  ? _rpm('TT_RPM_USD', 0.04)
            : 0.5
  const estimatedValueUsd = (views / 1000) * rpm

  // Estimated production cost: TTS chars (~3000 for short, ~16000 long) +
  // LLM planning tokens (~5000 input) + scraper API quota (~free at low scale)
  const isShort = avd < 60
  const ttsCost = (isShort ? 2000 : 12000) * TOKEN_COST.elevenlabs
  const llmCost = 5_000 * TOKEN_COST.openai + 3_000 * TOKEN_COST.anthropic
  const estimatedCostUsd = ttsCost + llmCost + (isShort ? 0.1 : 0.5)   // GPU amortization

  const roi      = estimatedValueUsd / Math.max(estimatedCostUsd, 0.01)
  const leverage = clamp01(ctr * 2 + (avd / 100))     // good CTR + watch time = leverage
  const risk     = views < 1000 ? 0.7 : views < 10_000 ? 0.4 : 0.2
  const score    = Math.min(100, roi * 8 + leverage * 30 - risk * 10)

  return {
    subject: videoId, kind: 'channel',
    estimatedCostUsd, estimatedValueUsd,
    roi, leverage, risk, score,
    evidence: [
      `${views} views`, `${(ctr * 100).toFixed(1)}% CTR`, `${avd.toFixed(0)}s AVD`,
      `cost ≈ $${estimatedCostUsd.toFixed(2)}`, `value ≈ $${estimatedValueUsd.toFixed(2)}`,
    ],
  }
}

/**
 * Workspace-level health snapshot: aggregate ROI across recent
 * productions, surface top winners + biggest wastes.
 */
export interface EconomicHealth {
  workspaceId: string
  totalProductions: number
  totalEstimatedCostUsd: number
  totalEstimatedValueUsd: number
  aggregateRoi: number
  topWinners: EconomicScore[]
  biggestWastes: EconomicScore[]
  recommendation: string
}

export async function workspaceHealth(workspaceId: string, days = 30): Promise<EconomicHealth> {
  const sinceMs = Date.now() - days * 86_400_000
  const rows = await db.execute(sql`
    SELECT source_ref FROM memories
    WHERE workspace_id = ${workspaceId}
      AND source = 'content-analytics'
      AND updated_at > ${sinceMs}
    ORDER BY updated_at DESC LIMIT 200`)
  const refs = ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? [])
    .map(r => String(r['source_ref'] ?? ''))
    .map(s => s.split(':')[1])
    .filter((id): id is string => !!id)

  const scores = (await Promise.all(refs.map(id => scorePublishedVideo(workspaceId, id))))
    .filter((s): s is EconomicScore => s !== null)

  const totalCost  = scores.reduce((a, s) => a + s.estimatedCostUsd, 0)
  const totalValue = scores.reduce((a, s) => a + s.estimatedValueUsd, 0)
  const sorted = [...scores].sort((a, b) => b.score - a.score)

  let recommendation = ''
  const aggregate = totalValue / Math.max(totalCost, 0.01)
  if (scores.length === 0) recommendation = 'No published productions yet — start with 3 shorts to gather signal.'
  else if (aggregate > 5)  recommendation = 'Strong ROI. Increase production cadence in the winner formats.'
  else if (aggregate > 1)  recommendation = 'Profitable. Refine hooks + thumbnails on the lower-scored items to lift average ROI.'
  else                     recommendation = 'Below break-even. Pause mass-produce, study top-3 winners, replicate their pattern only.'

  return {
    workspaceId,
    totalProductions: scores.length,
    totalEstimatedCostUsd: totalCost,
    totalEstimatedValueUsd: totalValue,
    aggregateRoi: aggregate,
    topWinners:  sorted.slice(0, 5),
    biggestWastes: [...sorted].sort((a, b) => a.score - b.score).slice(0, 3),
    recommendation,
  }
}

/**
 * Pricing simulation — for a digital product or service. Models break-
 * even, optimal price by demand-curve heuristic, sensitivity to churn.
 */
export interface PricingSim {
  candidatePriceUsd: number
  projectedMonthlyRevenueUsd: number
  projectedMonthlyProfitUsd: number
  breakEvenUsers: number
}

export function simulatePricing(input: {
  candidates: number[]
  fixedCostsUsdPerMonth: number
  variableCostUsdPerUser: number
  expectedConversionRate: number    // 0..1
  expectedMonthlyVisitors: number
}): PricingSim[] {
  const out: PricingSim[] = []
  for (const price of input.candidates) {
    // Demand curve: doubling price ~halves conversion (price-elasticity ≈ -1)
    const priceElasticity = 1 + (price - 50) / 100    // rough
    const adjConversion = input.expectedConversionRate / Math.max(0.3, priceElasticity)
    const users = input.expectedMonthlyVisitors * adjConversion
    const revenue = users * price
    const profit  = revenue - input.fixedCostsUsdPerMonth - users * input.variableCostUsdPerUser
    const breakEven = Math.ceil(input.fixedCostsUsdPerMonth / Math.max(price - input.variableCostUsdPerUser, 0.01))
    out.push({
      candidatePriceUsd: price,
      projectedMonthlyRevenueUsd: revenue,
      projectedMonthlyProfitUsd: profit,
      breakEvenUsers: breakEven,
    })
  }
  return out.sort((a, b) => b.projectedMonthlyProfitUsd - a.projectedMonthlyProfitUsd)
}
