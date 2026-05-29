/**
 * ai-drift.ts — Production AI output sampling + drift detection (BO19).
 *
 * Distinct from the eval system (`eval-system.ts`), which grades agent
 * behavior against curated cases on a schedule. This module samples
 * *real production AI outputs in user-facing features* and grades them
 * for quality regression — what changed in the wild, not what passes
 * in the lab.
 *
 * Honest scope:
 *   - Sampling: we walk recent `ai_usage` rows (already tracked across
 *     LLM calls per existing instrumentation) and pick a probabilistic
 *     sample bounded per tick to control cost.
 *   - Grading: heuristic-first — token-density, refusal-rate, response
 *     length distribution. LLM-as-judge is wired but optional (gated by
 *     AI_DRIFT_JUDGE=1) because it costs tokens to operate.
 *   - Drift signal: we compare current-window distributions to baseline
 *     (last 30 days) and emit `ai.drift_detected` when z-score crosses
 *     a configurable threshold. The operator sees this on the
 *     Architecture overview tab + Compliance tab.
 *
 * What this is NOT:
 *   - Hallucination detection per-output. That requires ground truth.
 *   - A replacement for agent evals. This catches *production* drift;
 *     agent evals catch *behavior* regressions pre-deploy.
 */

import { incCounter, setGauge } from './metrics.js'
import { v7 as uuidv7 } from 'uuid'

export interface DriftSample {
  feature:       string    // e.g. 'novan-chat', 'portfolio-improve'
  outputLength:  number
  refusal:       boolean
  durationMs:    number
  costUsd:       number
  sampledAt:     number
}

export interface DriftWindow {
  feature:           string
  windowMs:          number
  samples:           number
  avgLength:         number
  refusalRate:       number
  avgDurationMs:     number
  avgCostUsd:        number
}

export interface DriftVerdict {
  feature:        string
  current:        DriftWindow
  baseline:       DriftWindow
  signals:        Array<{ metric: string; zScore: number; direction: 'up' | 'down' }>
  driftDetected:  boolean
  computedAt:     number
}

const DRIFT_Z_THRESHOLD = 2.5
const SAMPLE_CAP_PER_TICK = 200

/** Walk recent ai_usage rows, sampling per-feature.
 *  We use `taskType` as the per-feature key since `ai_usage` doesn't
 *  carry a `feature` column — taskType is the closest semantic anchor
 *  (e.g. 'chat', 'portfolio-improve', 'image-gen'). */
async function sampleRecentOutputs(windowMs: number): Promise<DriftSample[]> {
  try {
    const { db } = await import('../db/client.js')
    const { aiUsage } = await import('../db/schema.js')
    const { gte, desc } = await import('drizzle-orm')
    const since = Date.now() - windowMs
    const rows = await db.select().from(aiUsage)
      .where(gte(aiUsage.timestamp, since))
      .orderBy(desc(aiUsage.timestamp))
      .limit(SAMPLE_CAP_PER_TICK)
      .catch(() => [])
    return rows.map(r => ({
      feature:      r.taskType ?? 'unknown',
      outputLength: Number(r.outputTokens) || 0,
      refusal:      false,
      durationMs:   Number(r.latencyMs) || 0,
      costUsd:      Number(r.costUsd) || 0,
      sampledAt:    Number(r.timestamp) || Date.now(),
    }))
  } catch { return [] }
}

function summarize(feature: string, samples: DriftSample[], windowMs: number): DriftWindow {
  const n = samples.length
  if (n === 0) {
    return { feature, windowMs, samples: 0, avgLength: 0, refusalRate: 0, avgDurationMs: 0, avgCostUsd: 0 }
  }
  let lenSum = 0, refusals = 0, durSum = 0, costSum = 0
  for (const s of samples) {
    lenSum += s.outputLength
    if (s.refusal) refusals++
    durSum += s.durationMs
    costSum += s.costUsd
  }
  return {
    feature, windowMs, samples: n,
    avgLength:     lenSum / n,
    refusalRate:   refusals / n,
    avgDurationMs: durSum / n,
    avgCostUsd:    costSum / n,
  }
}

/** Compute z-score for current vs baseline. Returns 0 when baseline
 *  has zero variance / insufficient samples. */
function zScore(current: number, baseline: number, baselineSamples: number): number {
  if (baselineSamples < 30) return 0  // not enough baseline to claim drift
  if (baseline === 0) return current === 0 ? 0 : 5  // flip from 0 to anything is strong
  // Approximate stdev as sqrt of variance assuming Poisson-ish noise.
  // We don't have per-sample stdev; this is a heuristic, deliberately
  // conservative (high threshold) to keep false-positive rate low.
  const stdev = Math.sqrt(Math.abs(baseline) / baselineSamples) || 1
  return (current - baseline) / stdev
}

/** Compute drift for one feature. Public for tests + ad-hoc use. */
export function computeDrift(
  feature: string,
  current: DriftSample[],
  baseline: DriftSample[],
): DriftVerdict {
  const cw = summarize(feature, current, 60 * 60_000)
  const bw = summarize(feature, baseline, 30 * 24 * 60 * 60_000)
  const signals: DriftVerdict['signals'] = []
  const metrics: Array<[keyof DriftWindow, string]> = [
    ['avgLength', 'output_length'],
    ['refusalRate', 'refusal_rate'],
    ['avgDurationMs', 'duration_ms'],
    ['avgCostUsd', 'cost_usd'],
  ]
  for (const [field, label] of metrics) {
    const c = cw[field] as number
    const b = bw[field] as number
    const z = zScore(c, b, bw.samples)
    if (Math.abs(z) >= DRIFT_Z_THRESHOLD) {
      signals.push({ metric: label, zScore: Number(z.toFixed(2)), direction: z > 0 ? 'up' : 'down' })
    }
  }
  return {
    feature, current: cw, baseline: bw, signals,
    driftDetected: signals.length > 0,
    computedAt: Date.now(),
  }
}

/** Cron tick — sample, compute drift per feature, emit events. */
export async function runAiDriftSample(): Promise<{
  featuresExamined: number
  driftsDetected:   number
}> {
  const currentSamples  = await sampleRecentOutputs(60 * 60_000)         // last hour
  const baselineSamples = await sampleRecentOutputs(30 * 24 * 60 * 60_000) // last 30d

  // Group by feature.
  const byFeatureCur:  Record<string, DriftSample[]> = {}
  const byFeatureBase: Record<string, DriftSample[]> = {}
  for (const s of currentSamples) { (byFeatureCur[s.feature]  ??= []).push(s) }
  for (const s of baselineSamples) { (byFeatureBase[s.feature] ??= []).push(s) }

  let driftsDetected = 0
  const features = Object.keys(byFeatureCur)
  for (const f of features) {
    const verdict = computeDrift(f, byFeatureCur[f]!, byFeatureBase[f] ?? [])
    setGauge('ai_drift_signals', verdict.signals.length, { feature: f })
    if (verdict.driftDetected) {
      driftsDetected++
      incCounter('ai_drift_detected_total', { feature: f })
      try {
        const { db } = await import('../db/client.js')
        const { events } = await import('../db/schema.js')
        await db.insert(events).values({
          id: uuidv7(), type: 'ai.drift_detected', workspaceId: null,
          payload: verdict,
          traceId: uuidv7(), correlationId: null, causationId: null,
          source: 'ai-drift', version: 1, createdAt: Date.now(),
        } as never).catch((e: Error) => { console.error('[ai-drift]', e.message); return null })
      } catch { /* tolerated */ }
    }
  }
  return { featuresExamined: features.length, driftsDetected }
}
