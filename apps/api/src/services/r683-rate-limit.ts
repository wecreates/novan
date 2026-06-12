/**
 * R683 — Simple token-bucket rate limiter for public surfaces.
 *
 * Each (key, bucketName) pair has capacity tokens refilling at refillRate per
 * second. Each request takes 1 token; reject when empty. Process-local Map
 * (multi-process deployments would lose state but we only run one API container).
 *
 * Buckets:
 *   chatStream   — 30/min  / 5 burst per IP
 *   agentStream  — 10/min  / 3 burst per IP
 *   webhookFire  — 60/min  / 20 burst per slug (not IP — external services
 *                  hit from many IPs, so we bucket per slug instead)
 */

interface Bucket { tokens: number; lastRefill: number }

interface BucketConfig { capacity: number; refillPerSec: number }

const CONFIGS: Record<string, BucketConfig> = {
  chatStream:  { capacity: 5,  refillPerSec: 30 / 60 },
  agentStream: { capacity: 3,  refillPerSec: 10 / 60 },
  webhookFire: { capacity: 20, refillPerSec: 60 / 60 },
}

const buckets = new Map<string, Bucket>()
const stats   = new Map<string, { allowed: number; rejected: number }>()

function statFor(name: string): { allowed: number; rejected: number } {
  let s = stats.get(name)
  if (!s) { s = { allowed: 0, rejected: 0 }; stats.set(name, s) }
  return s
}

/**
 * @returns true if the request is allowed (token consumed),
 *          false if rate-limited.
 */
export function take(name: keyof typeof CONFIGS | string, key: string): { allowed: boolean; retryAfterMs: number } {
  const cfg = CONFIGS[name]
  if (!cfg) return { allowed: true, retryAfterMs: 0 }
  const k = `${name}|${key}`
  const now = Date.now()
  let b = buckets.get(k)
  if (!b) {
    b = { tokens: cfg.capacity, lastRefill: now }
    buckets.set(k, b)
  } else {
    const elapsed = (now - b.lastRefill) / 1000
    b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec)
    b.lastRefill = now
  }
  const s = statFor(name)
  if (b.tokens >= 1) {
    b.tokens -= 1
    s.allowed++
    return { allowed: true, retryAfterMs: 0 }
  }
  s.rejected++
  const need = 1 - b.tokens
  const retryMs = Math.ceil((need / cfg.refillPerSec) * 1000)
  return { allowed: false, retryAfterMs: retryMs }
}

export function getRateStats(): Record<string, { allowed: number; rejected: number; rejectRate: number }> {
  const out: Record<string, { allowed: number; rejected: number; rejectRate: number }> = {}
  for (const [name, s] of stats) {
    const total = s.allowed + s.rejected
    out[name] = { ...s, rejectRate: total === 0 ? 0 : Number((s.rejected / total).toFixed(3)) }
  }
  return out
}
