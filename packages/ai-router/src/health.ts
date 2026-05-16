import type { ProviderHealth, ProviderStatus, ProviderId } from './types.js'
import { enabledProviders } from './providers.js'

// ─── In-memory health cache (TTL 60s) ────────────────────────────────────────

const cache = new Map<ProviderId, ProviderHealth>()
const CACHE_TTL = 60_000

// Rolling error window (last 10 requests per provider)
const errorWindows = new Map<ProviderId, boolean[]>()

export function recordProviderResult(provider: ProviderId, success: boolean): void {
  const window = errorWindows.get(provider) ?? []
  window.push(success)
  if (window.length > 10) window.shift()
  errorWindows.set(provider, window)

  const errorRate = window.filter((v) => !v).length / window.length
  const existing  = cache.get(provider)
  const status: ProviderStatus =
    errorRate >= 0.8 ? 'down' :
    errorRate >= 0.4 ? 'degraded' : 'healthy'

  cache.set(provider, {
    provider,
    status,
    latencyMs:  existing?.latencyMs ?? null,
    lastCheck:  Date.now(),
    errorRate,
  })
}

export function recordProviderLatency(provider: ProviderId, latencyMs: number): void {
  const existing = cache.get(provider)
  cache.set(provider, {
    provider,
    status:    existing?.status    ?? 'healthy',
    latencyMs,
    lastCheck: Date.now(),
    errorRate: existing?.errorRate ?? 0,
  })
}

export async function getProviderHealth(): Promise<ProviderHealth[]> {
  const providers = enabledProviders()
  return providers.map((p) => {
    const cached = cache.get(p.id)
    if (cached && Date.now() - cached.lastCheck < CACHE_TTL) return cached
    // Default healthy until proven otherwise
    return { provider: p.id, status: 'healthy' as ProviderStatus, latencyMs: null, lastCheck: Date.now(), errorRate: 0 }
  })
}

export function getProviderStatus(provider: ProviderId): ProviderStatus {
  return cache.get(provider)?.status ?? 'healthy'
}
