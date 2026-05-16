/**
 * Retry utilities — backoff computation and retry-eligibility checks.
 * Uses the canonical RetryPolicy shape from @ops/shared-types.
 */
import type { RetryPolicy } from '@ops/shared-types'
export type { RetryPolicy }

export { DEFAULT_RETRY_POLICY } from '@ops/shared-types'

/**
 * Compute the delay (ms) before the next retry attempt.
 * Applies exponential backoff with full jitter, capped at policy.maxBackoffMs.
 *
 * @param policy  - retry configuration
 * @param attempt - 1-indexed attempt number of the attempt that just failed
 */
export function computeBackoff(policy: RetryPolicy, attempt: number): number {
  const base = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1)
  const jitter = Math.random() * policy.backoffMs
  return Math.min(base + jitter, policy.maxBackoffMs)
}

/**
 * Whether the caller should issue another attempt.
 *
 * @param policy  - retry configuration
 * @param attempt - 1-indexed number of the attempt that just failed
 */
export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < policy.maxAttempts
}
