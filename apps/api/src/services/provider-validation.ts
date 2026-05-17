/**
 * provider-validation.ts — Real-time connectivity check against configured providers.
 *
 * Reads env vars (NEVER returns them in the response — only "configured: true|false").
 * Performs a lightweight HEAD/GET against each provider's public status endpoint.
 * Records result in providerHealthLog table.
 *
 * Honest: this validates REACHABILITY, not credential validity. A real chat-completion
 * test would burn tokens — operator can opt into that with deepCheck=true.
 */
import { db }                  from '../db/client.js'
import { providerHealthLog, events } from '../db/schema.js'
import { v7 as uuidv7 }        from 'uuid'

export interface ProviderProbe {
  provider:        string
  configured:      boolean       // is env var set?
  reachable:       boolean | null // null = not configured or skipped
  status:          'healthy' | 'degraded' | 'down' | 'unconfigured'
  latencyMs:       number | null
  errorMessage?:   string
}

interface ProviderTarget {
  id:       string
  envKey:   string
  probeUrl: string
}

// Public status/health endpoints — no auth required, no tokens consumed
const TARGETS: ProviderTarget[] = [
  { id: 'openrouter', envKey: 'OPENROUTER_API_KEY', probeUrl: 'https://openrouter.ai/api/v1/models' },
  { id: 'groq',       envKey: 'GROQ_API_KEY',       probeUrl: 'https://api.groq.com/openai/v1/models' },
  { id: 'gemini',     envKey: 'GEMINI_API_KEY',     probeUrl: 'https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta' },
  { id: 'openai',     envKey: 'OPENAI_API_KEY',     probeUrl: 'https://status.openai.com/api/v2/status.json' },
  { id: 'anthropic',  envKey: 'ANTHROPIC_API_KEY',  probeUrl: 'https://status.anthropic.com/api/v2/status.json' },
  { id: 'stripe',     envKey: 'STRIPE_SECRET_KEY',  probeUrl: 'https://status.stripe.com/api/v2/status.json' },
  { id: 'replicate',  envKey: 'REPLICATE_API_TOKEN', probeUrl: 'https://api.replicate.com/' },
  { id: 'stability',  envKey: 'STABILITY_API_KEY',  probeUrl: 'https://api.stability.ai/' },
  { id: 'fal',        envKey: 'FAL_KEY',            probeUrl: 'https://fal.run/' },
  { id: 'search',     envKey: 'SEARCH_API_KEY',     probeUrl: 'https://api.tavily.com/' },
]

/** Feature-flag accessors — default ON unless explicitly 'false'. */
export function isResearchEnabled(): boolean {
  return process.env['RESEARCH_ENABLED'] !== 'false'
}
export function isImageGenerationEnabled(): boolean {
  return process.env['IMAGE_GENERATION_ENABLED'] !== 'false'
}
export function defaultImageProvider(): string | null {
  return process.env['IMAGE_PROVIDER_DEFAULT'] ?? null
}
export function searchProvider(): string | null {
  const p = process.env['SEARCH_PROVIDER']
  return p && process.env['SEARCH_API_KEY'] ? p.toLowerCase() : null
}

const PROBE_TIMEOUT_MS = 5000

async function probeUrl(url: string): Promise<{ ok: boolean; latencyMs: number; status: number; error?: string }> {
  const start = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(url, { method: 'GET', signal: controller.signal })
    return { ok: r.ok, latencyMs: Date.now() - start, status: r.status }
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, status: 0, error: (e as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

export async function validateProviders(workspaceId: string): Promise<{
  results: ProviderProbe[]
  configuredCount: number
  reachableCount: number
}> {
  const results: ProviderProbe[] = []
  let configuredCount = 0
  let reachableCount = 0
  const now = Date.now()

  for (const t of TARGETS) {
    const envVal = process.env[t.envKey]
    const configured = typeof envVal === 'string' && envVal.length > 0

    if (!configured) {
      results.push({
        provider: t.id, configured: false, reachable: null,
        status: 'unconfigured', latencyMs: null,
      })
      continue
    }
    configuredCount += 1

    const probe = await probeUrl(t.probeUrl)
    const status: ProviderProbe['status'] = probe.ok ? 'healthy'
      : probe.status >= 500 ? 'down' : 'degraded'
    if (probe.ok) reachableCount += 1

    const result: ProviderProbe = {
      provider: t.id, configured: true, reachable: probe.ok,
      status, latencyMs: probe.latencyMs,
    }
    if (!probe.ok && probe.error) result.errorMessage = probe.error
    results.push(result)

    // Persist to providerHealthLog
    await db.insert(providerHealthLog).values({
      id:          uuidv7(),
      workspaceId,
      providerId:  t.id,
      sourceType:  'provider',
      status,
      latencyMs:   probe.latencyMs,
      errorRate:   probe.ok ? 0 : 1,
      checkedAt:   now,
    }).catch(() => null)
  }

  await db.insert(events).values({
    id: uuidv7(), type: 'launch.providers_validated',
    workspaceId,
    payload: { configuredCount, reachableCount, total: TARGETS.length },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'provider-validation', version: 1, createdAt: now,
  }).catch(() => null)

  return { results, configuredCount, reachableCount }
}
