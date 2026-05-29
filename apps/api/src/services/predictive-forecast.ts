/**
 * predictive-forecast.ts — simple linear-trend forecasting (#4).
 *
 * Pure functions over time-series counts. The anomaly detector already
 * catches *current* spikes; this module projects forward so the platform
 * can warn before the spike actually arrives.
 *
 * Inputs: dense bucketed counts (events per minute / cost per hour /
 * queue depth per minute). The model is intentionally simple — least-
 * squares linear regression with R² guarding — so the prediction is
 * explainable and never claims confidence it doesn't have.
 *
 * Two predictions exposed:
 *   forecastEventVolume(buckets)  → next-window count + confidence
 *   forecastBreachTime(buckets, threshold) → when (if ever) the series
 *     will cross the threshold, given the current trend
 *
 * Both return null trends when there isn't enough signal to be honest.
 */

export interface Bucket { t: number; value: number }

export interface LinearFit {
  slope:        number   // value per ms
  intercept:    number
  r2:           number   // 0..1
  samples:      number
}

/** Pure: least-squares linear regression over (t, value) buckets. */
export function fitLinear(buckets: ReadonlyArray<Bucket>): LinearFit | null {
  const n = buckets.length
  if (n < 4) return null
  // Normalize t to avoid huge intercepts
  const t0 = buckets[0]!.t
  const xs = buckets.map(b => b.t - t0)
  const ys = buckets.map(b => b.value)
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, denom = 0, ssRes = 0, ssTot = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - meanX) * (ys[i]! - meanY)
    denom += (xs[i]! - meanX) ** 2
  }
  if (denom === 0) return null
  const slope = num / denom
  const intercept = meanY - slope * meanX
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i]!
    ssRes += (ys[i]! - pred) ** 2
    ssTot += (ys[i]! - meanY) ** 2
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot)
  return { slope, intercept, r2, samples: n }
}

export interface VolumeForecast {
  predictedValue:   number
  trend:            'rising' | 'falling' | 'stable' | 'insufficient_data'
  confidence:       number   // 0..1 derived from R²
  horizonMs:        number
  fit:              LinearFit | null
}

/**
 * Predict the value `horizonMs` after the last bucket. Returns
 * insufficient_data when the fit is too weak to be trusted.
 */
export function forecastEventVolume(buckets: ReadonlyArray<Bucket>, horizonMs: number = 30 * 60_000): VolumeForecast {
  const fit = fitLinear(buckets)
  if (!fit || fit.r2 < 0.25 || buckets.length < 4) {
    return { predictedValue: 0, trend: 'insufficient_data', confidence: fit?.r2 ?? 0, horizonMs, fit }
  }
  const lastT = buckets[buckets.length - 1]!.t
  const t0    = buckets[0]!.t
  const projT = (lastT - t0) + horizonMs
  const predicted = Math.max(0, fit.intercept + fit.slope * projT)
  // Slope direction relative to the typical bucket value
  const meanY = buckets.reduce((a, b) => a + b.value, 0) / buckets.length
  const slopePerWindow = fit.slope * horizonMs
  const trend: VolumeForecast['trend'] =
      slopePerWindow >  meanY * 0.05 ? 'rising'
    : slopePerWindow < -meanY * 0.05 ? 'falling'
    : 'stable'
  return { predictedValue: Number(predicted.toFixed(2)), trend, confidence: Number(fit.r2.toFixed(3)), horizonMs, fit }
}

export interface BreachForecast {
  willBreach:   boolean
  etaMs:        number | null    // when the breach is expected, ms from now
  confidence:   number
  reason:       string
}

/**
 * When (relative to now) will the series cross `threshold` given its
 * current linear trend? Returns willBreach=false when the trend is
 * flat / declining or when the fit is too weak.
 */
export function forecastBreachTime(buckets: ReadonlyArray<Bucket>, threshold: number): BreachForecast {
  const fit = fitLinear(buckets)
  if (!fit || fit.r2 < 0.25) {
    return { willBreach: false, etaMs: null, confidence: fit?.r2 ?? 0, reason: 'insufficient trend' }
  }
  if (fit.slope <= 0) {
    return { willBreach: false, etaMs: null, confidence: fit.r2, reason: 'series is flat or declining' }
  }
  const lastT = buckets[buckets.length - 1]!.t
  const t0    = buckets[0]!.t
  const lastX = lastT - t0
  // Solve threshold = intercept + slope * x for x
  const breachX = (threshold - fit.intercept) / fit.slope
  if (breachX <= lastX) {
    return { willBreach: true, etaMs: 0, confidence: fit.r2, reason: 'already at or past threshold' }
  }
  const etaMs = breachX - lastX
  return { willBreach: true, etaMs: Number(etaMs.toFixed(0)), confidence: Number(fit.r2.toFixed(3)), reason: 'projected from linear trend' }
}

/** Pure: bucket a flat array of timestamps into N equal-width buckets
 *  across [start, end]. Useful for converting raw event rows into a
 *  series before fitting. */
export function bucketize(timestamps: ReadonlyArray<number>, start: number, end: number, bucketCount: number): Bucket[] {
  if (bucketCount <= 0 || end <= start) return []
  const width = (end - start) / bucketCount
  const buckets: Bucket[] = []
  for (let i = 0; i < bucketCount; i++) buckets.push({ t: start + i * width + width / 2, value: 0 })
  for (const ts of timestamps) {
    if (ts < start || ts >= end) continue
    const idx = Math.min(bucketCount - 1, Math.floor((ts - start) / width))
    buckets[idx]!.value++
  }
  return buckets
}
