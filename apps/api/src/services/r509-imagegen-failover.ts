/**
 * R509 — Image-gen provider health probe + failover ordering.
 *
 * R382 / R374 image generation currently routes via R333 capability
 * registry. This service hourly probes each configured provider with a
 * cheap generation call and persists the result. R333 routing reads the
 * latest probe and orders providers by recent success.
 *
 * Operator-visible: dashboard widget shows "FAL: ok · Replicate: degraded
 * · Stability: down" so operator can switch order or top up before R382's
 * actual run.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

const PROBE_PROVIDERS = ['fal', 'replicate', 'stability', 'openai'] as const

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS image_provider_health (
      provider          TEXT PRIMARY KEY,
      last_probed_at    BIGINT NOT NULL,
      last_status       TEXT NOT NULL,    -- 'ok' | 'degraded' | 'down' | 'unconfigured'
      last_latency_ms   INTEGER NOT NULL,
      last_error        TEXT,
      consecutive_fails INTEGER NOT NULL DEFAULT 0
    )
  `).catch(() => {})
}

function isConfigured(provider: string): boolean {
  if (provider === 'fal')       return Boolean(process.env['FAL_KEY'] ?? process.env['FAL_API_KEY'])
  if (provider === 'replicate') return Boolean(process.env['REPLICATE_API_TOKEN'])
  if (provider === 'stability') return Boolean(process.env['STABILITY_API_KEY'])
  if (provider === 'openai')    return Boolean(process.env['OPENAI_API_KEY'])
  return false
}

/**
 * Cheap probe — just hit a health endpoint. Real generation probe would
 * burn credits hourly; we trade depth for cost. R333.v2 (in the pending
 * task list) deepens these probes.
 */
async function probe(provider: string): Promise<{ ok: boolean; latencyMs: number; reason?: string }> {
  if (!isConfigured(provider)) return { ok: false, latencyMs: 0, reason: 'unconfigured' }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 5_000)
  const start = Date.now()
  try {
    let url: string
    if (provider === 'fal')            url = 'https://fal.run/health'
    else if (provider === 'replicate') url = 'https://api.replicate.com/v1/account'
    else if (provider === 'stability') url = 'https://api.stability.ai/v1/user/account'
    else if (provider === 'openai')    url = 'https://api.openai.com/v1/models'
    else                                url = ''
    if (!url) return { ok: false, latencyMs: 0, reason: 'no probe URL' }
    const res = await fetch(url, { signal: ac.signal, headers: authHeaders(provider) })
    const latency = Date.now() - start
    if (res.ok) return { ok: true, latencyMs: latency }
    return { ok: false, latencyMs: latency, reason: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, reason: (e as Error).message.slice(0, 100) }
  } finally { clearTimeout(t) }
}

function authHeaders(provider: string): Record<string, string> {
  if (provider === 'replicate') return { 'Authorization': `Token ${process.env['REPLICATE_API_TOKEN']}` }
  if (provider === 'stability') return { 'Authorization': `Bearer ${process.env['STABILITY_API_KEY']}` }
  if (provider === 'openai')    return { 'Authorization': `Bearer ${process.env['OPENAI_API_KEY']}` }
  if (provider === 'fal')       return { 'Authorization': `Key ${process.env['FAL_KEY'] ?? process.env['FAL_API_KEY']}` }
  return {}
}

export async function probeAllProviders(): Promise<{ probed: number; healthy: number }> {
  await ensureTable()
  let probed = 0, healthy = 0
  for (const p of PROBE_PROVIDERS) {
    probed++
    const r = await probe(p)
    const status = !isConfigured(p) ? 'unconfigured' : r.ok ? 'ok' : (r.latencyMs > 4500 ? 'degraded' : 'down')
    if (status === 'ok') healthy++
    await db.execute(sql`
      INSERT INTO image_provider_health (provider, last_probed_at, last_status, last_latency_ms, last_error, consecutive_fails)
      VALUES (${p}, ${Date.now()}, ${status}, ${r.latencyMs}, ${r.reason ?? null}, ${r.ok ? 0 : 1})
      ON CONFLICT (provider) DO UPDATE
      SET last_probed_at = EXCLUDED.last_probed_at,
          last_status    = EXCLUDED.last_status,
          last_latency_ms = EXCLUDED.last_latency_ms,
          last_error     = EXCLUDED.last_error,
          consecutive_fails = CASE WHEN EXCLUDED.last_status = 'ok' THEN 0 ELSE image_provider_health.consecutive_fails + 1 END
    `).catch(() => {/* tolerated */})
  }
  return { probed, healthy }
}

export interface ProviderHealth {
  provider:           string
  lastStatus:         string
  lastLatencyMs:      number
  consecutiveFails:   number
  lastError:          string | null
  configured:         boolean
}
export async function providerHealthSnapshot(): Promise<ProviderHealth[]> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT provider, last_status, last_latency_ms, consecutive_fails, last_error
      FROM image_provider_health ORDER BY (last_status = 'ok') DESC, consecutive_fails ASC
    `)
    return (r as unknown as Array<{ provider: string; last_status: string; last_latency_ms: number; consecutive_fails: number; last_error: string | null }>).map(x => ({
      provider: x.provider, lastStatus: x.last_status, lastLatencyMs: Number(x.last_latency_ms),
      consecutiveFails: Number(x.consecutive_fails), lastError: x.last_error, configured: isConfigured(x.provider),
    }))
  } catch { return [] }
}

/** R333 routing helper — returns providers ordered by health (healthy first). */
export async function healthyProviderOrder(): Promise<string[]> {
  const snap = await providerHealthSnapshot()
  return snap.filter(p => p.configured && p.lastStatus === 'ok').map(p => p.provider)
}
