/**
 * provider-concurrency.ts — per-provider concurrency caps.
 *
 * Pure-Node primitive: a Map of providerId → in-flight counter +
 * configurable cap. Used by image-generator / speech-router-style
 * services to refuse dispatch when a provider is already saturated,
 * with operator-visible reasons.
 *
 * Caps are configurable per provider with `setProviderCap(id, n)`.
 * Defaults are conservative so a single bad provider can't starve the
 * platform: 4 in-flight per provider, 16 total.
 *
 * No DB — counters live in process memory. Each Fastify instance has
 * its own counters; for a multi-instance deployment, swap the Map for
 * a Redis INCR/DECR pair. The interface stays identical.
 */

const DEFAULT_CAP = 4
const TOTAL_CAP   = 16

const caps = new Map<string, number>()
const inflight = new Map<string, number>()
let totalInflight = 0

export interface AcquireResult {
  ok:        boolean
  provider:  string
  inflight:  number
  cap:       number
  reason?:   string
}

export function setProviderCap(provider: string, cap: number): void {
  if (!Number.isFinite(cap) || cap < 1) return
  caps.set(provider, Math.min(64, Math.floor(cap)))
}
export function getProviderCap(provider: string): number {
  return caps.get(provider) ?? DEFAULT_CAP
}
export function getProviderInflight(provider: string): number {
  return inflight.get(provider) ?? 0
}

/** Snapshot of current concurrency state across all known providers. */
export function snapshotConcurrency(): Array<{ provider: string; inflight: number; cap: number; saturated: boolean }> {
  const providers = new Set<string>([...caps.keys(), ...inflight.keys()])
  return [...providers].map(p => {
    const cur = getProviderInflight(p)
    const cap = getProviderCap(p)
    return { provider: p, inflight: cur, cap, saturated: cur >= cap }
  }).sort((a, b) => b.inflight - a.inflight)
}

/** Try to acquire a slot. Returns ok=false (with reason) when capped. */
export function tryAcquire(provider: string): AcquireResult {
  const cap = getProviderCap(provider)
  const cur = getProviderInflight(provider)
  if (cur >= cap) {
    return { ok: false, provider, inflight: cur, cap, reason: `provider saturated (${cur}/${cap})` }
  }
  if (totalInflight >= TOTAL_CAP) {
    return { ok: false, provider, inflight: cur, cap, reason: `total in-flight cap reached (${totalInflight}/${TOTAL_CAP})` }
  }
  inflight.set(provider, cur + 1)
  totalInflight++
  return { ok: true, provider, inflight: cur + 1, cap }
}

/** Always call after the dispatched job completes (success OR failure). */
export function release(provider: string): void {
  const cur = inflight.get(provider) ?? 0
  if (cur <= 0) return
  inflight.set(provider, cur - 1)
  totalInflight = Math.max(0, totalInflight - 1)
}

/**
 * Run a dispatched job through the semaphore: acquire → run → release.
 * Caller decides how to react when ok=false (queue, fail-over, drop).
 */
export async function withSlot<T>(provider: string, fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  const slot = tryAcquire(provider)
  if (!slot.ok) return { ok: false, reason: slot.reason ?? 'saturated' }
  try {
    const result = await fn()
    return { ok: true, result }
  } finally {
    release(provider)
  }
}

/** Test hook — reset all counters. NOT for production calls. */
export function _resetForTests(): void {
  caps.clear()
  inflight.clear()
  totalInflight = 0
}
