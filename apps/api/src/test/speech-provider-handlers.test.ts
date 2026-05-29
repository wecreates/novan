/**
 * Tests for speech-provider-handlers — handler dispatch, stubbed mint
 * flows for each vendor, server-side barge-in semantics, and graceful
 * failure when keys / endpoints are missing.
 *
 * Vendor HTTP calls are intercepted via a stub `fetchImpl` so no real
 * network traffic occurs during CI.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})
// Avoid the vault's reveal/decrypt path — return null so handlers report
// 'no key configured' for the unconfigured cases, and inject keys directly
// where we want a successful mint.
vi.mock('../services/secrets-vault.js', () => ({
  revealSecret: async (id: string) => id === 'present' ? 'sk-fake' : null,
}))

import { getHandler, supportedRealtimeProviders, registerHandler, type SpeechProviderHandler } from '../services/speech-provider-handlers.js'
import type { ProviderRow } from '../services/speech-providers.js'

function row(over: Partial<ProviderRow>): ProviderRow {
  return {
    id: 'cfg-1', providerId: over.providerId ?? 'openai_realtime',
    displayName: 'x', kind: 'realtime_s2s',
    enabled: true, priority: 100,
    preferredVoice: null, preferredLocale: 'en-US',
    maxCostPerMinUsd: 0.5, maxLatencyMs: 1500,
    supportsStreaming: true, supportsInterruption: true,
    healthScore: 1, lastLatencyMs: null, lastError: null, lastHealthAt: null,
    hasKey: false, keyRef: null, endpoint: null, catalogue: null,
    ...over,
  }
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('speech-provider-handlers: dispatch', () => {
  it('returns specific handlers for known providers', () => {
    expect(getHandler('openai_realtime').id).toBe('openai_realtime')
    expect(getHandler('gemini_live').id).toBe('gemini_live')
    expect(getHandler('deepgram_stt').id).toBe('deepgram_stt')
    expect(getHandler('custom').id).toBe('custom')
  })

  it('returns the unsupported stub for unknown providers', async () => {
    const h = getHandler('elevenlabs')   // catalogue ok, but TTS-only — not realtime
    const r = await h.mintSession({ workspaceId: 'ws', cfg: row({ providerId: 'elevenlabs' }), locale: 'en-US' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not support realtime/i)
  })

  it('exposes supportedRealtimeProviders()', () => {
    const ids = supportedRealtimeProviders()
    expect(ids).toContain('openai_realtime')
    expect(ids).toContain('gemini_live')
    expect(ids).toContain('deepgram_stt')
    expect(ids).toContain('custom')
  })

  it('registerHandler allows operators to extend the catalogue', async () => {
    const fake: SpeechProviderHandler = {
      id: 'fake-vendor',
      async mintSession() { return { ok: true, session: { clientToken: 't', providerSessionId: 's', expiresAt: Date.now() + 60_000 } } },
    }
    registerHandler(fake)
    expect(supportedRealtimeProviders()).toContain('fake-vendor')
    const r = await getHandler('fake-vendor').mintSession({ workspaceId: 'w', cfg: row({ providerId: 'fake-vendor' }), locale: 'en' })
    expect(r.ok).toBe(true)
  })
})

describe('speech-provider-handlers: OpenAI Realtime', () => {
  it('mints a session with the vendor-supplied client_secret', async () => {
    const h = getHandler('openai_realtime')
    const fetchImpl = vi.fn(async () => jsonRes({
      id: 'sess_abc', model: 'gpt-4o-realtime-preview', voice: 'alloy',
      client_secret: { value: 'eph_secret', expires_at: Math.floor((Date.now() + 60_000) / 1000) },
    })) as unknown as typeof fetch
    const r = await h.mintSession({ workspaceId: 'ws', cfg: row({ keyRef: 'present' }), locale: 'en-US', fetchImpl })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.session.providerSessionId).toBe('sess_abc')
      expect(r.session.clientToken).toBe('eph_secret')
      expect(r.session.url).toMatch(/realtime/)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns failure when no key is configured', async () => {
    const r = await getHandler('openai_realtime').mintSession({ workspaceId: 'ws', cfg: row({ keyRef: null }), locale: 'en' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no key/i)
  })

  it('surfaces vendor 4xx as a structured failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    const r = await getHandler('openai_realtime').mintSession({ workspaceId: 'ws', cfg: row({ keyRef: 'present' }), locale: 'en', fetchImpl })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.httpStatus).toBe(429)
      expect(r.reason).toMatch(/mint failed: 429/)
    }
  })

  it('bargeIn is a no-op success (browser handles WebRTC cancel)', async () => {
    const h = getHandler('openai_realtime')
    expect(h.bargeIn).toBeDefined()
    const r = await h.bargeIn!({ workspaceId: 'ws', cfg: row({}), locale: 'en' }, 'sess_abc')
    expect(r.ok).toBe(true)
  })
})

describe('speech-provider-handlers: Gemini Live', () => {
  it('mints with the ephemeralAuthTokens endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/ephemeralAuthTokens/)
      return jsonRes({ name: 'eph_tok_xyz', token: 'eph_tok_xyz' })
    }) as unknown as typeof fetch
    const r = await getHandler('gemini_live').mintSession({ workspaceId: 'ws', cfg: row({ providerId: 'gemini_live', keyRef: 'present' }), locale: 'en-US', fetchImpl })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.session.clientToken).toBe('eph_tok_xyz')
      expect(r.session.url).toMatch(/wss?:\/\//)
    }
  })

  it('fails when response is missing token field', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({})) as unknown as typeof fetch
    const r = await getHandler('gemini_live').mintSession({ workspaceId: 'ws', cfg: row({ providerId: 'gemini_live', keyRef: 'present' }), locale: 'en', fetchImpl })
    expect(r.ok).toBe(false)
  })
})

describe('speech-provider-handlers: Deepgram STT', () => {
  it('requires endpoint to carry the project_id', async () => {
    const r = await getHandler('deepgram_stt').mintSession({ workspaceId: 'ws', cfg: row({ providerId: 'deepgram_stt', keyRef: 'present', endpoint: null }), locale: 'en' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/project_id/i)
  })

  it('mints a temporary key via the projects/keys endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toMatch(/projects\/proj-1\/keys/)
      return jsonRes({ key: 'dg_temp_key', api_key_id: 'apikey_1' })
    }) as unknown as typeof fetch
    const r = await getHandler('deepgram_stt').mintSession({
      workspaceId: 'ws',
      cfg: row({ providerId: 'deepgram_stt', keyRef: 'present', endpoint: 'https://api.deepgram.com/v1/projects/proj-1' }),
      locale: 'en-US',
      fetchImpl,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.session.clientToken).toBe('dg_temp_key')
      expect(r.session.url).toMatch(/wss:\/\/api\.deepgram\.com\/v1\/listen/)
    }
  })

  it('bargeIn returns a labelled no-op (STT has no audio output)', async () => {
    const r = await getHandler('deepgram_stt').bargeIn!({ workspaceId: 'ws', cfg: row({ providerId: 'deepgram_stt' }), locale: 'en' }, 'x')
    expect(r.ok).toBe(true)
    expect(r.reason).toMatch(/STT/i)
  })
})

describe('speech-provider-handlers: custom endpoint', () => {
  it('refuses when endpoint is missing', async () => {
    const r = await getHandler('custom').mintSession({ workspaceId: 'ws', cfg: row({ providerId: 'custom', endpoint: null }), locale: 'en' })
    expect(r.ok).toBe(false)
  })

  it('trusts the endpoint response when complete', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({
      clientToken: 'tok', providerSessionId: 'sess', url: 'wss://x/y', expiresAt: Date.now() + 30_000,
    })) as unknown as typeof fetch
    const r = await getHandler('custom').mintSession({
      workspaceId: 'ws',
      cfg: row({ providerId: 'custom', endpoint: 'https://operator.example/voice/mint', keyRef: 'present' }),
      locale: 'en', fetchImpl,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.session.url).toBe('wss://x/y')
  })

  it('rejects an incomplete custom response', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ clientToken: 'only-token' })) as unknown as typeof fetch
    const r = await getHandler('custom').mintSession({
      workspaceId: 'ws',
      cfg: row({ providerId: 'custom', endpoint: 'https://x', keyRef: 'present' }),
      locale: 'en', fetchImpl,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/incomplete/i)
  })
})

describe('speech-provider-handlers: safety / privacy', () => {
  it('never includes the raw key in a successful session response', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({
      id: 's', client_secret: { value: 'eph_secret', expires_at: Math.floor(Date.now() / 1000) + 60 },
      model: 'gpt-4o-realtime-preview', voice: 'alloy',
    })) as unknown as typeof fetch
    const r = await getHandler('openai_realtime').mintSession({ workspaceId: 'ws', cfg: row({ keyRef: 'present' }), locale: 'en', fetchImpl })
    if (!r.ok) throw new Error('expected ok')
    const json = JSON.stringify(r.session)
    expect(json).not.toContain('sk-fake')     // raw vault value never leaks
    expect(json).toContain('eph_secret')      // ephemeral token DOES leak (intended — browser needs it)
  })

  it('thrown vendor errors are caught and surfaced as failures (no unhandled rejection)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('DNS_FAIL') }) as unknown as typeof fetch
    const r = await getHandler('openai_realtime').mintSession({ workspaceId: 'ws', cfg: row({ keyRef: 'present' }), locale: 'en', fetchImpl })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/DNS_FAIL/)
  })
})
