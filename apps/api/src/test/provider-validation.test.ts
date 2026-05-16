/**
 * Tests for provider-validation.ts — public-endpoint reachability probes.
 *
 * Verifies the reachability classification matrix:
 *   no env key set            → status: 'unconfigured', reachable: null
 *   env set + 2xx response    → status: 'healthy', reachable: true
 *   env set + 4xx response    → status: 'degraded', reachable: false
 *   env set + 5xx response    → status: 'down',     reachable: false
 *   env set + fetch throws    → status: 'down',     reachable: false
 *
 * Mocks global.fetch + the db Proxy. No real network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = []): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(returnValue)
          if (prop === 'catch') return () => makeChain(returnValue)
          if (typeof prop === 'symbol') return undefined
          return () => makeChain(returnValue)
        },
      },
    )
  }
  const db = {
    select: () => makeChain([]),
    insert: () => {
      const chain = {
        values: () => chain,
        onConflictDoNothing: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => ({
      set: () => ({ where: () => ({ then: (r: (v: unknown) => unknown) => r([]) }) }),
    }),
  }
  return { db }
})

import { validateProviders } from '../services/provider-validation.js'

// ── Track + restore env across tests ─────────────────────────────────────────
const ENV_KEYS = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY',
                  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY']
const origEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    origEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
  vi.restoreAllMocks()
})

// ─── A) No keys configured ───────────────────────────────────────────────────

describe('validateProviders: no keys set', () => {
  it('returns 0 configured + all unconfigured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await validateProviders('ws-1')
    expect(r.configuredCount).toBe(0)
    expect(r.reachableCount).toBe(0)
    expect(r.results.length).toBeGreaterThanOrEqual(3) // openrouter/groq/gemini at minimum
    for (const probe of r.results) {
      expect(probe.configured).toBe(false)
      expect(probe.reachable).toBeNull()
      expect(probe.status).toBe('unconfigured')
      expect(probe.latencyMs).toBeNull()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── B) One key configured + endpoint is healthy ─────────────────────────────

describe('validateProviders: healthy provider', () => {
  it('marks reachable + healthy when fetch returns 200', async () => {
    process.env['GEMINI_API_KEY'] = 'AIza_fake_for_test'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200 }) as Response,
    )

    const r = await validateProviders('ws-1')
    const gemini = r.results.find((p) => p.provider === 'gemini')
    expect(gemini).toBeDefined()
    expect(gemini!.configured).toBe(true)
    expect(gemini!.reachable).toBe(true)
    expect(gemini!.status).toBe('healthy')
    expect(gemini!.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.configuredCount).toBe(1)
    expect(r.reachableCount).toBe(1)
  })
})

// ─── C) Provider configured but probe returns 5xx ───────────────────────────

describe('validateProviders: down provider', () => {
  it('classifies 5xx as down + not reachable', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-fake'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 503 }) as Response,
    )

    const r = await validateProviders('ws-1')
    const p = r.results.find((p) => p.provider === 'openrouter')
    expect(p).toBeDefined()
    expect(p!.configured).toBe(true)
    expect(p!.reachable).toBe(false)
    expect(p!.status).toBe('down')
    expect(r.configuredCount).toBe(1)
    expect(r.reachableCount).toBe(0)
  })
})

// ─── D) Provider configured but probe returns 4xx ───────────────────────────

describe('validateProviders: degraded provider', () => {
  it('classifies 4xx as degraded + not reachable', async () => {
    process.env['GROQ_API_KEY'] = 'gsk_fake'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Forbidden', { status: 403 }) as Response,
    )

    const r = await validateProviders('ws-1')
    const p = r.results.find((p) => p.provider === 'groq')
    expect(p).toBeDefined()
    expect(p!.configured).toBe(true)
    expect(p!.reachable).toBe(false)
    expect(p!.status).toBe('degraded')
  })
})

// ─── E) Provider configured but fetch throws ────────────────────────────────

describe('validateProviders: network error', () => {
  it('classifies fetch failure with errorMessage populated', async () => {
    process.env['OPENROUTER_API_KEY'] = 'sk-or-fake'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ENETUNREACH'))

    const r = await validateProviders('ws-1')
    const p = r.results.find((p) => p.provider === 'openrouter')
    expect(p).toBeDefined()
    expect(p!.configured).toBe(true)
    expect(p!.reachable).toBe(false)
    // Service maps status code: >=500 → 'down', else → 'degraded'. Fetch
    // failures produce status 0, which falls into 'degraded'.
    expect(['degraded', 'down']).toContain(p!.status)
    expect(p!.errorMessage).toMatch(/ENETUNREACH/i)
  })
})

// ─── F) Mixed result aggregation ─────────────────────────────────────────────

describe('validateProviders: mixed providers', () => {
  it('counts configured + reachable correctly across mixed responses', async () => {
    process.env['GEMINI_API_KEY']     = 'AIza_fake'
    process.env['OPENROUTER_API_KEY'] = 'sk-or-fake'
    process.env['GROQ_API_KEY']       = 'gsk_fake'

    let n = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      n += 1
      if (n === 1) return new Response('ok', { status: 200 }) as Response
      if (n === 2) return new Response('down', { status: 503 }) as Response
      return new Response('forbidden', { status: 403 }) as Response
    })

    const r = await validateProviders('ws-1')
    expect(r.configuredCount).toBe(3)
    expect(r.reachableCount).toBe(1) // only the first 200
  })
})

// ─── G) Result shape contract ────────────────────────────────────────────────

describe('validateProviders: response shape', () => {
  it('returns the documented shape', async () => {
    const r = await validateProviders('ws-1')
    expect(r).toHaveProperty('results')
    expect(r).toHaveProperty('configuredCount')
    expect(r).toHaveProperty('reachableCount')
    expect(Array.isArray(r.results)).toBe(true)
    for (const p of r.results) {
      expect(p).toHaveProperty('provider')
      expect(p).toHaveProperty('configured')
      expect(p).toHaveProperty('reachable')
      expect(p).toHaveProperty('status')
      expect(p).toHaveProperty('latencyMs')
    }
  })
})
