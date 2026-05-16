/**
 * Provider Scoring Engine — pure functions, no DB, no side effects.
 *
 * All scores are 0–1 (higher = better).
 * Composite score is a weighted sum of the four sub-scores.
 */

// ─── Sub-scores ───────────────────────────────────────────────────────────────

/** Latency score: 0 ms → 1.0, 5000 ms+ → 0.0 (linear decay). */
export function computeLatencyScore(latencyMs: number): number {
  if (latencyMs <= 0) return 1.0
  return Math.max(0, 1 - latencyMs / 5_000)
}

/** Success rate score: errorRate 0.0 → 1.0, errorRate 1.0 → 0.0. */
export function computeSuccessRateScore(errorRate: number): number {
  return Math.max(0, Math.min(1, 1 - errorRate))
}

/**
 * Cost score: lower cost per request → higher score.
 * Relative to baselineUsd (default 1 cent) using a hyperbolic curve.
 */
export function computeCostScore(costUsdPerRequest: number, baselineUsd = 0.01): number {
  if (costUsdPerRequest <= 0) return 1.0
  return Math.max(0, Math.min(1, baselineUsd / (costUsdPerRequest + baselineUsd)))
}

/**
 * Capability score: fraction of required capabilities the provider satisfies.
 * Empty requirements → 1.0 (unconstrained).
 */
export function computeCapabilityScore(
  providerCapabilities: string[],
  requiredCapabilities: string[],
): number {
  if (requiredCapabilities.length === 0) return 1.0
  const matched = requiredCapabilities.filter((c) => providerCapabilities.includes(c)).length
  return matched / requiredCapabilities.length
}

// ─── Composite score ──────────────────────────────────────────────────────────

export interface ScoreWeights {
  latency:     number   // default 0.30
  successRate: number   // default 0.40
  cost:        number   // default 0.20
  capability:  number   // default 0.10
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  latency: 0.30, successRate: 0.40, cost: 0.20, capability: 0.10,
}

export interface ProviderScoreInput {
  latencyMs:            number
  errorRate:            number    // 0–1
  costUsdPerRequest:    number
  capabilities:         string[]
  requiredCapabilities: string[]
}

export function computeCompositeScore(
  input: ProviderScoreInput,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): number {
  const ls  = computeLatencyScore(input.latencyMs)
  const ss  = computeSuccessRateScore(input.errorRate)
  const cs  = computeCostScore(input.costUsdPerRequest)
  const cap = computeCapabilityScore(input.capabilities, input.requiredCapabilities)

  return (
    ls  * weights.latency +
    ss  * weights.successRate +
    cs  * weights.cost +
    cap * weights.capability
  )
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitStatus {
  state:       CircuitState
  shouldAllow: boolean
  reason?:     string
}

const CIRCUIT_FAILURE_THRESHOLD = 5
const CIRCUIT_RECOVERY_MS       = 60_000   // 1 minute before probe

/**
 * Evaluate current circuit state to decide whether a request should proceed.
 * Does NOT mutate state — returns a new recommendation.
 */
export function evaluateCircuit(
  state:      CircuitState,
  failures:   number,
  openedAtMs: number | null,
  nowMs:      number = Date.now(),
): CircuitStatus {
  if (state === 'open') {
    if (openedAtMs !== null && nowMs - openedAtMs > CIRCUIT_RECOVERY_MS) {
      return { state: 'half_open', shouldAllow: true, reason: 'recovery probe' }
    }
    return { state: 'open', shouldAllow: false, reason: 'circuit open' }
  }

  if (state === 'half_open') {
    return { state: 'half_open', shouldAllow: true, reason: 'half-open probe' }
  }

  // closed
  if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    return { state: 'open', shouldAllow: false, reason: `${failures} consecutive failures` }
  }
  return { state: 'closed', shouldAllow: true }
}

/**
 * Compute the next circuit state after a request result.
 * success=true resets failures and closes the circuit.
 * success=false increments failures and may open the circuit.
 */
export function nextCircuitState(
  currentState:    CircuitState,
  success:         boolean,
  currentFailures: number,
): { state: CircuitState; failures: number } {
  if (success) {
    return { state: 'closed', failures: 0 }
  }
  const failures = currentFailures + 1
  if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    return { state: 'open', failures }
  }
  // half_open failure → re-open immediately
  if (currentState === 'half_open') {
    return { state: 'open', failures }
  }
  return { state: currentState, failures }
}
