/**
 * provider-retry.ts — Exponential backoff + per-provider circuit breaker
 * for external LLM/AI provider HTTP calls.
 *
 * Why:
 *   - Groq returns 503 intermittently under load.
 *   - All providers occasionally rate-limit (429) or 5xx.
 *   - A single failed call shouldn't bubble up if a retry would succeed.
 *
 * Strategy:
 *   - Retry on 429, 5xx, network errors, AbortError.
 *   - Exponential backoff: 250ms, 750ms, 2000ms (capped 3 retries).
 *   - Per-provider circuit breaker: 5 failures in 30s → open for 60s.
 *     While open, calls fail fast instead of hammering the provider.
 *
 * Honest scope: this wraps the INITIAL request only. Once a stream
 * starts, mid-stream errors are not retried (would require replay logic).
 */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])
const MAX_RETRIES        = 3
const BACKOFF_MS         = [250, 750, 2000]   // 3 attempts total after the first

// ─── Circuit breaker ──────────────────────────────────────────────────────────

interface BreakerState {
  failures:    number   // count of recent failures
  windowStart: number   // ms — start of current failure window
  openUntil:   number   // ms — circuit stays open until this time (0 = closed)
}

const breakers = new Map<string, BreakerState>()
const FAILURE_WINDOW_MS = 30_000   // count failures over 30s
const FAILURE_THRESHOLD = 5        // ...trip after 5
const OPEN_DURATION_MS  = 60_000   // ...stay open for 60s, then half-open (1 try)

function getBreaker(provider: string): BreakerState {
  // Single-threaded JS — the get→set window contains no await points
  // so two callers can't interleave between them. Any apparent race
  // disappears because once a caller enters this function it runs to
  // completion before the event loop yields. Documented so future
  // refactors (e.g. introducing an async lookup) don't re-introduce
  // a window without realising they need a lock.
  let b = breakers.get(provider)
  if (!b) {
    b = { failures: 0, windowStart: Date.now(), openUntil: 0 }
    breakers.set(provider, b)
  }
  return b
}

function recordSuccess(provider: string): void {
  const b = getBreaker(provider)
  b.failures = 0
  b.windowStart = Date.now()
  b.openUntil = 0
}

function recordFailure(provider: string): void {
  const b = getBreaker(provider)
  const now = Date.now()
  // Reset window if expired
  if (now - b.windowStart > FAILURE_WINDOW_MS) {
    b.failures = 1
    b.windowStart = now
    return
  }
  b.failures++
  if (b.failures >= FAILURE_THRESHOLD) {
    b.openUntil = now + OPEN_DURATION_MS
  }
}

export function isCircuitOpen(provider: string): boolean {
  const b = getBreaker(provider)
  return Date.now() < b.openUntil
}

export function circuitState(provider: string): { open: boolean; failures: number; openUntil: number } {
  const b = getBreaker(provider)
  return { open: Date.now() < b.openUntil, failures: b.failures, openUntil: b.openUntil }
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

export interface RetryableFetchResult {
  ok:       true
  response: Response
}
export interface RetryableFetchFailure {
  ok:           false
  status:       number
  statusText:   string
  attempts:     number
  circuitOpen?: boolean
}

/**
 * Fetch with exponential backoff + circuit breaker.
 * Returns a discriminated union — never throws.
 *
 * Retries on: 408, 425, 429, 5xx, network/abort errors.
 * Honors `Retry-After` header when present (capped at 5s to keep latency sane).
 */
export async function fetchWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<RetryableFetchResult | RetryableFetchFailure> {
  if (isCircuitOpen(provider)) {
    return { ok: false, status: 0, statusText: `circuit-breaker-open for ${provider}`, attempts: 0, circuitOpen: true }
  }

  let lastStatus = 0
  let lastText   = ''
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) {
        recordSuccess(provider)
        return { ok: true, response: res }
      }
      lastStatus = res.status
      lastText   = res.statusText
      if (!RETRYABLE_STATUSES.has(res.status)) {
        // Non-retryable 4xx — record as failure for circuit-breaker
        // signal (chronic auth errors still trip the breaker) but
        // return immediately.
        recordFailure(provider)
        return { ok: false, status: res.status, statusText: res.statusText, attempts: attempt + 1 }
      }
      // Retryable. Honor Retry-After when present.
      const retryAfterRaw = res.headers.get('retry-after')
      let waitMs = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
      if (retryAfterRaw) {
        const ra = Number(retryAfterRaw)
        if (Number.isFinite(ra) && ra > 0) waitMs = Math.min(ra * 1000, 5000)
      }
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, waitMs))
    } catch (e) {
      lastStatus = 0
      lastText   = (e as Error).message
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!))
      }
    }
  }
  recordFailure(provider)
  return { ok: false, status: lastStatus, statusText: lastText, attempts: MAX_RETRIES + 1 }
}
