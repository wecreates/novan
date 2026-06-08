/**
 * R146.333 — Provider Health Monitor + Auto-Failover
 *
 * Codifies the lesson from R332: providers fail silently for distinct reasons
 * (revoked key / no balance / spend cap / rate-limit / network) and operators
 * burn hours discovering each one in sequence. Novan should probe everything
 * continuously, classify the failure, and auto-route around dead providers
 * BEFORE the operator hits a wall mid-workflow.
 *
 * Probes are deliberately cheap-or-free per provider:
 *   - Image:  small text request (no actual image generated where possible)
 *   - LLM:    1-token completion
 *   - Connector OAuth tokens: token-info endpoint
 *
 * Persists to provider_health table. Read by image-router + chat-providers
 * to skip known-dead providers immediately instead of waiting for a real
 * call to fail.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'

export type FailureClass =
  | 'ok'
  | 'auth_revoked'        // 401/403 — key revoked, regenerate
  | 'billing_exhausted'   // 402/429 spend cap — top up
  | 'rate_limited'        // 429 transient — retry later
  | 'not_found'           // 404 — model/endpoint doesn't exist
  | 'network'             // timeout, DNS, TLS — usually transient
  | 'unknown'

export interface ProbeResult {
  provider:     string
  model?:       string
  ok:           boolean
  failureClass: FailureClass
  latencyMs:    number
  message:      string
  probedAt:     number
}

// ─── Provider probes ─────────────────────────────────────────────────────────

async function probeFal(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['FAL_KEY']
  if (!key) return mkResult('fal', false, 'unknown', t0, 'no FAL_KEY env')
  try {
    // Cheapest possible: HEAD on credit endpoint
    const res = await fetch('https://fal.run/health', {
      method:  'GET',
      headers: { Authorization: `Key ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401 || res.status === 403)
      return mkResult('fal', false, 'auth_revoked', t0, `${res.status} ${res.statusText}`)
    if (res.status === 402)
      return mkResult('fal', false, 'billing_exhausted', t0, 'no credit balance')
    if (res.status === 429)
      return mkResult('fal', false, 'rate_limited', t0, 'rate limited')
    if (res.status >= 500)
      return mkResult('fal', false, 'network', t0, `upstream ${res.status}`)
    return mkResult('fal', true, 'ok', t0, 'ok')
  } catch (e) {
    return mkResult('fal', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeReplicate(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['REPLICATE_API_TOKEN']
  if (!key) return mkResult('replicate', false, 'unknown', t0, 'no REPLICATE_API_TOKEN env')
  try {
    const res = await fetch('https://api.replicate.com/v1/account', {
      method:  'GET',
      headers: { Authorization: `Token ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401 || res.status === 403)
      return mkResult('replicate', false, 'auth_revoked', t0, `${res.status}`)
    if (res.status === 402)
      return mkResult('replicate', false, 'billing_exhausted', t0, 'payment required')
    if (res.status === 429)
      return mkResult('replicate', false, 'rate_limited', t0, 'rate limited')
    if (!res.ok)
      return mkResult('replicate', false, 'unknown', t0, `status ${res.status}`)
    return mkResult('replicate', true, 'ok', t0, 'ok')
  } catch (e) {
    return mkResult('replicate', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeGeminiImage(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['GEMINI_API_KEY']
  if (!key) return mkResult('gemini_image', false, 'unknown', t0, 'no GEMINI_API_KEY env')
  try {
    // ListModels is free + does not consume image quota
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
      { method: 'GET', signal: AbortSignal.timeout(8_000) },
    )
    if (res.status === 401 || res.status === 403)
      return mkResult('gemini_image', false, 'auth_revoked', t0, `${res.status}`)
    if (res.status === 429) {
      // Could be rate limit OR spend cap — fetch body to distinguish
      const body = await res.text()
      const cls: FailureClass = /spending cap|RESOURCE_EXHAUSTED/i.test(body)
        ? 'billing_exhausted' : 'rate_limited'
      return mkResult('gemini_image', false, cls, t0, body.slice(0, 200))
    }
    if (!res.ok)
      return mkResult('gemini_image', false, 'unknown', t0, `status ${res.status}`)
    return mkResult('gemini_image', true, 'ok', t0, 'ok (list-models reachable)')
  } catch (e) {
    return mkResult('gemini_image', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeOpenAI(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['OPENAI_API_KEY']
  if (!key) return mkResult('openai', false, 'unknown', t0, 'no OPENAI_API_KEY env')
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method:  'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401) return mkResult('openai', false, 'auth_revoked', t0, '401')
    if (res.status === 429) return mkResult('openai', false, 'rate_limited', t0, '429')
    if (!res.ok)            return mkResult('openai', false, 'unknown', t0, `${res.status}`)
    return mkResult('openai', true, 'ok', t0, 'ok')
  } catch (e) {
    return mkResult('openai', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeGroq(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['GROQ_API_KEY']
  if (!key) return mkResult('groq', false, 'unknown', t0, 'no GROQ_API_KEY env')
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401) return mkResult('groq', false, 'auth_revoked', t0, '401')
    if (res.status === 429) return mkResult('groq', false, 'rate_limited', t0, '429')
    if (!res.ok)            return mkResult('groq', false, 'unknown', t0, `${res.status}`)
    return mkResult('groq', true, 'ok', t0, 'ok')
  } catch (e) {
    return mkResult('groq', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeHorde(): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    // /api/v2/status/heartbeat is free + tells us workers are running
    const res = await fetch('https://stablehorde.net/api/v2/status/heartbeat', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return mkResult('horde', false, 'network', t0, `status ${res.status}`)
    return mkResult('horde', true, 'ok', t0, 'ok (anonymous tier always available)')
  } catch (e) {
    return mkResult('horde', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeHuggingFace(): Promise<ProbeResult> {
  const t0 = Date.now()
  const key = process.env['HF_TOKEN']
  if (!key) return mkResult('huggingface', false, 'unknown', t0, 'no HF_TOKEN env (free signup at huggingface.co)')
  try {
    // R343 — router.huggingface.co/v1/models is the OpenAI-compatible
    // catalog endpoint. Returns models the token can hit. Cheap probe.
    const res = await fetch('https://router.huggingface.co/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401 || res.status === 403)
      return mkResult('huggingface', false, 'auth_revoked', t0, `${res.status}`)
    if (res.status === 402)
      return mkResult('huggingface', false, 'billing_exhausted', t0, '402 payment required')
    if (res.status === 429)
      return mkResult('huggingface', false, 'rate_limited', t0, '429')
    return mkResult('huggingface', res.ok, 'ok', t0, res.ok ? 'ok (router.huggingface.co reachable)' : `status ${res.status}`)
  } catch (e) {
    return mkResult('huggingface', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

async function probeCloudflare(): Promise<ProbeResult> {
  const t0 = Date.now()
  const token = process.env['CF_API_TOKEN']
  const acct  = process.env['CF_ACCOUNT_ID']
  if (!token || !acct) return mkResult('cloudflare', false, 'unknown', t0, 'no CF_API_TOKEN + CF_ACCOUNT_ID env')
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
      signal:  AbortSignal.timeout(8_000),
    })
    if (res.status === 401 || res.status === 403)
      return mkResult('cloudflare', false, 'auth_revoked', t0, `${res.status}`)
    return mkResult('cloudflare', res.ok, 'ok', t0, res.ok ? 'ok' : `status ${res.status}`)
  } catch (e) {
    return mkResult('cloudflare', false, 'network', t0, (e as Error).message.slice(0, 200))
  }
}

const PROBES: Array<() => Promise<ProbeResult>> = [
  probeFal, probeReplicate, probeGeminiImage, probeOpenAI, probeGroq,
  probeHorde, probeHuggingFace, probeCloudflare,
]

function mkResult(provider: string, ok: boolean, cls: FailureClass, t0: number, message: string): ProbeResult {
  return { provider, ok, failureClass: cls, latencyMs: Date.now() - t0, message, probedAt: Date.now() }
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function persist(r: ProbeResult): Promise<void> {
  // Raw SQL — schema-package round-trip is too slow for hot-deploy.
  // Table created via direct SQL migration; this just upserts.
  try {
    await db.execute(sql`
      INSERT INTO provider_health (id, provider, ok, failure_class, latency_ms, message, probed_at)
      VALUES (${uuidv7()}, ${r.provider}, ${r.ok}, ${r.failureClass}, ${r.latencyMs}, ${r.message.slice(0, 500)}, ${r.probedAt})
      ON CONFLICT (provider) DO UPDATE SET
        ok            = EXCLUDED.ok,
        failure_class = EXCLUDED.failure_class,
        latency_ms    = EXCLUDED.latency_ms,
        message       = EXCLUDED.message,
        probed_at     = EXCLUDED.probed_at
    `)
  } catch (e) {
    console.error('[r333-provider-health] persist failed:', (e as Error).message)
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Probe all providers concurrently. Used by cron + on-demand admin call.
 * Returns the snapshot for immediate display; also persists to DB.
 */
export async function probeAll(): Promise<ProbeResult[]> {
  const results = await Promise.all(PROBES.map(p => p().catch((e: Error) => mkResult(
    'unknown', false, 'unknown', Date.now(), `probe threw: ${e.message.slice(0, 100)}`,
  ))))
  await Promise.all(results.map(persist))
  return results
}

/**
 * Cheap read of the latest snapshot — used by image-router + chat-providers
 * to skip known-dead providers in their selection step.
 */
export async function getHealthSnapshot(): Promise<Record<string, ProbeResult>> {
  try {
    const rows = await db.execute(sql`
      SELECT provider, ok, failure_class, latency_ms, message, probed_at
      FROM provider_health
    `) as unknown as Array<{
      provider: string; ok: boolean; failure_class: string | null;
      latency_ms: number | null; message: string | null; probed_at: string | number
    }>
    const out: Record<string, ProbeResult> = {}
    for (const row of rows) {
      out[row.provider] = {
        provider:     row.provider,
        ok:           row.ok,
        failureClass: (row.failure_class as FailureClass) ?? 'unknown',
        latencyMs:    row.latency_ms ?? 0,
        message:      row.message ?? '',
        probedAt:     Number(row.probed_at) || 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Filter a list of candidate providers down to ones currently healthy.
 * Falls back to returning the input if no health data is available
 * (don't block on missing telemetry).
 */
export async function filterHealthy(candidates: string[]): Promise<string[]> {
  const snap = await getHealthSnapshot()
  if (Object.keys(snap).length === 0) return candidates
  return candidates.filter(c => {
    const h = snap[c]
    if (!h) return true                                  // never probed = optimistic
    if (h.ok) return true
    // Allow rate_limited through (transient); block hard failures
    return h.failureClass === 'rate_limited' || h.failureClass === 'network'
  })
}

/**
 * Single canonical "is the platform able to generate images right now"
 * boolean. Used to surface a clear status to the operator without them
 * having to interpret provider lists.
 */
export async function canGenerateImagesNow(): Promise<{ ok: boolean; reason: string; healthyProviders: string[] }> {
  const snap = await getHealthSnapshot()
  const imageProviders = ['fal', 'replicate', 'gemini_image', 'openai', 'horde', 'huggingface', 'cloudflare']
  const healthy = imageProviders.filter(p => snap[p]?.ok)
  if (healthy.length > 0) {
    return { ok: true, reason: `${healthy.length} provider(s) healthy`, healthyProviders: healthy }
  }
  // Identify the dominant failure class to give a single actionable message
  const classes = imageProviders.map(p => snap[p]?.failureClass).filter(Boolean) as FailureClass[]
  const hasAuth    = classes.includes('auth_revoked')
  const hasBilling = classes.includes('billing_exhausted')
  let reason = 'no image providers healthy'
  if (hasAuth && hasBilling)
    reason = 'all image providers blocked — auth-revoked AND billing-exhausted; regenerate keys + top up'
  else if (hasAuth)
    reason = 'all image provider keys revoked — regenerate at least one'
  else if (hasBilling)
    reason = 'all image providers out of credit — top up Replicate ($5 = ~500 images) or raise Gemini cap'
  return { ok: false, reason, healthyProviders: [] }
}
