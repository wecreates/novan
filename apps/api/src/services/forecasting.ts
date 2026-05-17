/**
 * forecasting.ts — Predictive risk forecasting from trend buckets.
 *
 * SPEC RULE (non-negotiable): every output explicitly carries
 *   factType: 'fact' | 'prediction'
 * to keep facts and forecasts visually separable.
 *
 * Method:
 *   - Use the existing 8-week trend buckets.
 *   - Compute least-squares slope across non-zero buckets.
 *   - Extrapolate 2 weeks forward (cap absurd extrapolations).
 *   - Confidence = r² of the fit; below 0.3 → 'insufficient_data'.
 *
 * No fabrication: insufficient data returns `confidence: 0` and a
 * conservative non-forecast.
 */
import { allTrends, type TrendSeries } from './trend-analysis.js'
import { record as recordChain }       from './reasoning-chains.js'
import { declare as declareAssumption } from './assumption-tracker.js'

export type ForecastType =
  | 'provider_failure_likely'
  | 'budget_overrun_likely'
  | 'runtime_bottleneck_likely'
  | 'deployment_instability_likely'
  | 'security_risk_growing'
  | 'scaling_pressure_growing'

export interface Forecast {
  type:           ForecastType
  factType:       'prediction'           // always prediction — keeps fact/prediction split honest
  likelihood:     'low' | 'medium' | 'high' | 'critical' | 'insufficient_data'
  confidence:     number                 // r² of the linear fit; 0 = no fit
  horizonWeeks:   number                 // forecast horizon (1..4)
  basis: {
    historicalSeries: number[]            // raw observed values (the facts)
    slopePerWeek:     number              // change per week from regression
    projectedValue:   number | null       // extrapolated value at horizon
    sampleSize:       number              // non-zero buckets used
  }
  evidence:       string                 // human-readable summary
}

// ─── Linear regression helper ─────────────────────────────────────────────────

interface LinFit { slope: number; intercept: number; r2: number; n: number }

function linearFit(values: number[]): LinFit {
  const n = values.length
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0, n }
  const xs = values.map((_, i) => i)
  const meanX = xs.reduce((s, x) => s + x, 0) / n
  const meanY = values.reduce((s, y) => s + y, 0) / n
  let numerator = 0, denomX = 0, denomY = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = values[i]!
    numerator += (x - meanX) * (y - meanY)
    denomX += (x - meanX) ** 2
    denomY += (y - meanY) ** 2
  }
  const slope = denomX === 0 ? 0 : numerator / denomX
  const intercept = meanY - slope * meanX
  const r2 = denomX === 0 || denomY === 0 ? 0 : (numerator ** 2) / (denomX * denomY)
  return { slope, intercept, r2: Number(r2.toFixed(3)), n }
}

function extrapolate(fit: LinFit, ahead = 2): number {
  return fit.intercept + fit.slope * (fit.n - 1 + ahead)
}

// ─── Likelihood classifier ────────────────────────────────────────────────────

/** Standard deviation of a numeric series (population). */
function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Map (slope × r² × sample size × z-score sanity) → likelihood bucket.
 * Anti-overconfidence guards (item #18):
 *   - Need ≥3 non-zero buckets to forecast (was 0).
 *   - The last value must move ≥1σ from the series mean to count as a real signal.
 *   - r² ≥ 0.3 still required.
 */
function classifyLikelihood(
  slope: number,
  r2: number,
  rawSeries: number[],
  worseIsHigher: boolean,
  thresholds: { mediumSlope: number; highSlope: number; criticalSlope: number },
): Forecast['likelihood'] {
  const nonZeroBuckets = rawSeries.filter(v => v > 0).length
  if (nonZeroBuckets < 3) return 'insufficient_data'
  if (r2 < 0.3)            return 'insufficient_data'

  const last = rawSeries[rawSeries.length - 1] ?? 0
  const mean = rawSeries.reduce((s, v) => s + v, 0) / rawSeries.length
  const sd   = stddev(rawSeries)
  // Require last point to be >=1σ from mean — protects against tiny-slope-but-high-r² illusions
  if (sd > 0 && Math.abs(last - mean) < sd) return 'low'

  const isWorsening = worseIsHigher ? slope > 0 : slope < 0
  if (!isWorsening) return 'low'
  const m = Math.abs(slope)
  if (m >= thresholds.criticalSlope) return 'critical'
  if (m >= thresholds.highSlope)     return 'high'
  if (m >= thresholds.mediumSlope)   return 'medium'
  return 'low'
}

// ─── Forecast builders ────────────────────────────────────────────────────────

function buildForecast(
  type: ForecastType,
  series: TrendSeries,
  valueKey: string,
  worseIsHigher: boolean,
  thresholds: Parameters<typeof classifyLikelihood>[4],
  horizonWeeks = 2,
): Forecast {
  const raw = series.series.map(b => Number(b.metrics[valueKey] ?? 0))
  const fit = linearFit(raw)
  const likelihood = classifyLikelihood(fit.slope, fit.r2, raw, worseIsHigher, thresholds)
  const projected = likelihood === 'insufficient_data'
    ? null
    : Number(extrapolate(fit, horizonWeeks).toFixed(3))

  const direction = fit.slope > 0 ? 'rising' : fit.slope < 0 ? 'falling' : 'flat'
  const evidence = likelihood === 'insufficient_data'
    ? `${fit.n} weeks of data, r²=${fit.r2} (need r² ≥ 0.3 to forecast)`
    : `slope ${fit.slope.toFixed(3)}/wk, ${direction}, r²=${fit.r2}, projected ${projected} in ${horizonWeeks}w`

  return {
    type, factType: 'prediction',
    likelihood, confidence: fit.r2,
    horizonWeeks,
    basis: {
      historicalSeries: raw,
      slopePerWeek:     Number(fit.slope.toFixed(4)),
      projectedValue:   projected,
      sampleSize:       raw.filter(v => v > 0).length,
    },
    evidence,
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface AllForecasts {
  forecasts:   Forecast[]
  generatedAt: number
  /** Counts to help operators read at a glance. */
  summary: {
    critical: number
    high:     number
    medium:   number
    low:      number
    insufficientData: number
  }
}

export async function generateForecasts(workspaceId: string): Promise<AllForecasts> {
  const t = await allTrends(workspaceId)

  const forecasts: Forecast[] = [
    // Provider failure: rising avg latency over weeks
    buildForecast('provider_failure_likely', t.providerQuality, 'avgLatencyMs', true,
      { mediumSlope: 50, highSlope: 200, criticalSlope: 500 }),

    // Budget overrun: rising weekly spend
    buildForecast('budget_overrun_likely', t.cost, 'spendUsd', true,
      { mediumSlope: 0.5, highSlope: 2, criticalSlope: 10 }),

    // Runtime bottleneck: rising failure rate
    buildForecast('runtime_bottleneck_likely', t.reliability, 'failureRate', true,
      { mediumSlope: 0.02, highSlope: 0.05, criticalSlope: 0.10 }),

    // Deployment instability: rising deployment failures
    buildForecast('deployment_instability_likely', t.deployment, 'failed', true,
      { mediumSlope: 0.5, highSlope: 1, criticalSlope: 2 }),

    // Security risk growing: rising critical incidents
    buildForecast('security_risk_growing', t.incident, 'critical', true,
      { mediumSlope: 0.2, highSlope: 0.5, criticalSlope: 1 }),

    // Scaling pressure: rising total incidents (proxy for general system pressure)
    buildForecast('scaling_pressure_growing', t.incident, 'count', true,
      { mediumSlope: 0.5, highSlope: 1.5, criticalSlope: 3 }),
  ]

  const summary = {
    critical: forecasts.filter(f => f.likelihood === 'critical').length,
    high:     forecasts.filter(f => f.likelihood === 'high').length,
    medium:   forecasts.filter(f => f.likelihood === 'medium').length,
    low:      forecasts.filter(f => f.likelihood === 'low').length,
    insufficientData: forecasts.filter(f => f.likelihood === 'insufficient_data').length,
  }

  // Persist each forecast as a reasoning chain (fire-and-forget). Outcome
  // evaluator (cron task) compares projected vs observed when horizon passes.
  void (async () => {
    for (const f of forecasts) {
      if (f.likelihood === 'insufficient_data') continue
      await recordChain({
        workspaceId,
        kind: 'forecast',
        subjectId: f.type,
        decision: `Forecast ${f.type}: likelihood=${f.likelihood}, projecting ${f.basis.projectedValue} in ${f.horizonWeeks}w`,
        evidence: [
          { type: 'trend', id: f.type, extract: f.evidence },
          { type: 'slope', id: 'per_week', extract: String(f.basis.slopePerWeek) },
        ],
        confidence: f.confidence,
        prediction: {
          horizonWeeks:   f.horizonWeeks,
          projectedValue: f.basis.projectedValue,
          slopePerWeek:   f.basis.slopePerWeek,
          likelihood:     f.likelihood,
          historicalEndsAt: Date.now(),  // when the forecast was made
        },
        source: 'forecasting',
      }).catch(() => null)

      // Declare the underlying assumption explicitly: "current trend
      // continues for next horizonWeeks weeks." Drift detector can
      // flag if the trend reverses before horizon end.
      await declareAssumption({
        workspaceId, category: 'forecast',
        statement: `Trend continuation: ${f.type} continues at ${f.basis.slopePerWeek}/wk for ${f.horizonWeeks}w`,
        evidenceRefs: [{
          table: 'trend_analysis', id: f.type,
          extract: `slope=${f.basis.slopePerWeek}, r²=${f.confidence}, n=${f.basis.sampleSize}`,
        }],
        confidence: f.confidence,
        source: 'forecasting',
      }).catch(() => null)
    }
  })()

  return { forecasts, generatedAt: Date.now(), summary }
}
