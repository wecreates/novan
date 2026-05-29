/**
 * model-governance.ts — provider trust scoring + degradation tracking (#46).
 *
 * Pure scorer + DB-backed rollup. Composites a per-(provider, model)
 * trust score from real telemetry already in the platform:
 *
 *   - image_generations         : success rate, avg quality, slop risk
 *   - voice_quality_feedback    : operator ratings per provider
 *   - events (provider.error.*) : recent failure / hallucination flags
 *
 * Outputs:
 *   trustScore   0..1   composite (higher = more trustworthy)
 *   hallucinationRate   fraction of recent outputs flagged
 *   degradationDelta    trustScore now vs trustScore in prior window
 *
 * The router can consume `trustScore` as a routing input (it already
 * accepts `qualityScores`). Operators can see degrading providers in
 * the war room and rotate them out before quality collapses.
 *
 * Pure functions tested with fixtures; DB wrapper composes inputs.
 */
import { db } from '../db/client.js'
import { imageGenerations, voiceQualityFeedback, events } from '../db/schema.js'
import { and, eq, gte, sql } from 'drizzle-orm'

export interface ProviderTelemetry {
  provider:           string
  model:              string | null
  samples:            number
  successRate:        number    // 0..1
  avgQuality:         number    // 0..1 (from image_quality + voice feedback composite)
  hallucinationFlags: number    // count of operator-marked / classifier-flagged outputs
  recentErrors:       number    // count of provider.error.* events in window
  avgLatencyMs:       number
  costVariance:       number    // 0..1 — coefficient of variation
}

export interface TrustVerdict {
  provider:           string
  model:              string | null
  trustScore:         number       // 0..1
  hallucinationRate:  number       // 0..1
  verdict:            'trusted' | 'watching' | 'degrading' | 'rotate'
  reasons:            string[]
  samples:            number
}

const MIN_SAMPLES = 5

/** Pure: derive a trust verdict from telemetry. */
export function scoreProviderTrust(t: ProviderTelemetry): TrustVerdict {
  const reasons: string[] = []
  if (t.samples < MIN_SAMPLES) {
    return {
      provider: t.provider, model: t.model,
      trustScore: 0.5, hallucinationRate: 0,
      verdict: 'watching',
      reasons: [`insufficient-data:${t.samples}/${MIN_SAMPLES}`],
      samples: t.samples,
    }
  }

  const hallucinationRate = t.samples === 0 ? 0 : t.hallucinationFlags / t.samples
  reasons.push(`success=${(t.successRate * 100).toFixed(0)}%`)
  reasons.push(`quality=${(t.avgQuality * 100).toFixed(0)}%`)
  reasons.push(`hallucination=${(hallucinationRate * 100).toFixed(1)}%`)

  // Composite — success and quality are most important; hallucinations
  // are heavily penalized; latency and variance are tiebreakers.
  let trust =
      0.35 * t.successRate
    + 0.30 * t.avgQuality
    - 0.40 * hallucinationRate
    + 0.10 * (1 - Math.min(1, t.recentErrors / 10))
    + 0.05 * (1 - Math.min(1, t.avgLatencyMs / 10_000))
    + 0.05 * (1 - Math.min(1, t.costVariance))
  trust = Math.max(0, Math.min(1, trust))
  trust = Number(trust.toFixed(3))

  let verdict: TrustVerdict['verdict'] = 'trusted'
  if      (trust < 0.30)               verdict = 'rotate'
  else if (trust < 0.50)               verdict = 'degrading'
  else if (trust < 0.70)               verdict = 'watching'

  if (hallucinationRate > 0.10) reasons.push('high-hallucination')
  if (t.recentErrors > 5)       reasons.push(`recent-errors:${t.recentErrors}`)
  if (t.avgLatencyMs > 5000)    reasons.push(`slow:${Math.round(t.avgLatencyMs)}ms`)

  return {
    provider: t.provider, model: t.model,
    trustScore: trust, hallucinationRate: Number(hallucinationRate.toFixed(3)),
    verdict, reasons, samples: t.samples,
  }
}

export interface ProviderDegradation {
  provider:        string
  model:           string | null
  trustNow:        number
  trustPrior:      number
  delta:           number      // negative = degrading
  verdictNow:      TrustVerdict['verdict']
}

/** Pure: compare two snapshots and surface degrading providers. */
export function detectDegradation(now: TrustVerdict[], prior: TrustVerdict[]): ProviderDegradation[] {
  const priorByKey = new Map(prior.map(v => [`${v.provider}::${v.model ?? ''}`, v]))
  const out: ProviderDegradation[] = []
  for (const n of now) {
    const p = priorByKey.get(`${n.provider}::${n.model ?? ''}`)
    if (!p) continue
    const delta = n.trustScore - p.trustScore
    if (delta < -0.10) {
      out.push({
        provider:    n.provider,
        model:       n.model,
        trustNow:    n.trustScore,
        trustPrior:  p.trustScore,
        delta:       Number(delta.toFixed(3)),
        verdictNow:  n.verdict,
      })
    }
  }
  return out.sort((a, b) => a.delta - b.delta)
}

// ─── DB-backed rollup ─────────────────────────────────────────────────

export async function rollupProviderTrust(workspaceId: string, opts: { windowMs?: number } = {}): Promise<TrustVerdict[]> {
  const windowMs = opts.windowMs ?? 7 * 86_400_000
  const since = Date.now() - windowMs

  // Image side: success rate, latency, quality
  const imgRows = await db.select({
    provider: imageGenerations.provider,
    model:    imageGenerations.model,
    samples:  sql<number>`count(*)::int`,
    successes: sql<number>`count(*) FILTER (WHERE status = 'succeeded')::int`,
    avgQuality: sql<number>`avg(coalesce(${imageGenerations.qualityScore}, 0))::float`,
    flags:     sql<number>`count(*) FILTER (WHERE ${imageGenerations.slopRiskScore} > 0.7)::int`,
    avgLatency: sql<number>`avg(coalesce(${imageGenerations.latencyMs}, 0))::float`,
    costStdev:  sql<number>`coalesce(stddev_pop(${imageGenerations.actualCostUsd}), 0)::float`,
    costAvg:    sql<number>`coalesce(avg(${imageGenerations.actualCostUsd}), 0.001)::float`,
  }).from(imageGenerations)
    .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, since)))
    .groupBy(imageGenerations.provider, imageGenerations.model)
    .catch(() => [])

  // Voice side: operator ratings per provider (1..5 → 0..1)
  const voiceRows = await db.select({
    provider: voiceQualityFeedback.provider,
    samples:  sql<number>`count(*)::int`,
    avgScore: sql<number>`avg(coalesce(${voiceQualityFeedback.naturalness}, 0) + coalesce(${voiceQualityFeedback.usefulness}, 0))::float / 10.0`,
  }).from(voiceQualityFeedback)
    .where(and(eq(voiceQualityFeedback.workspaceId, workspaceId), gte(voiceQualityFeedback.createdAt, since)))
    .groupBy(voiceQualityFeedback.provider)
    .catch(() => [])

  // Recent provider errors
  const errRows = await db.select({
    payload: events.payload,
  }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      gte(events.createdAt, since),
      sql`${events.type} LIKE 'provider.%error%' OR ${events.type} LIKE '%.mint_failed' OR ${events.type} LIKE '%.failed'`,
    ))
    .limit(500).catch(() => [])
  const errorsByProvider = new Map<string, number>()
  for (const r of errRows) {
    const p = (r.payload as { provider?: string } | null)?.provider
    if (!p) continue
    errorsByProvider.set(p, (errorsByProvider.get(p) ?? 0) + 1)
  }

  const verdicts: TrustVerdict[] = []
  for (const r of imgRows) {
    const t: ProviderTelemetry = {
      provider: r.provider,
      model:    r.model,
      samples:  Number(r.samples) || 0,
      successRate: Number(r.samples) === 0 ? 0 : Number(r.successes) / Number(r.samples),
      avgQuality:  Number(r.avgQuality) || 0,
      hallucinationFlags: Number(r.flags) || 0,
      recentErrors:       errorsByProvider.get(r.provider) ?? 0,
      avgLatencyMs:       Number(r.avgLatency) || 0,
      costVariance:       Number(r.costAvg) <= 0 ? 0 : Math.min(1, Number(r.costStdev) / Number(r.costAvg)),
    }
    verdicts.push(scoreProviderTrust(t))
  }
  for (const r of voiceRows) {
    if (!r.provider) continue
    const t: ProviderTelemetry = {
      provider: r.provider, model: null,
      samples:    Number(r.samples) || 0,
      successRate: 1,    // voice feedback rows are completed sessions
      avgQuality:  Math.max(0, Math.min(1, Number(r.avgScore) || 0)),
      hallucinationFlags: 0,
      recentErrors:       errorsByProvider.get(r.provider) ?? 0,
      avgLatencyMs:       0,
      costVariance:       0,
    }
    verdicts.push(scoreProviderTrust(t))
  }
  return verdicts.sort((a, b) => b.trustScore - a.trustScore)
}
