/**
 * Tests for speech-router — selection scoring, failover chain,
 * realtime vs fallback mode, locale filter, no-hardcoded-provider invariant.
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

import { decideFromRows, getPreset, VOICE_PRESETS } from '../services/speech-router.js'
import { PROVIDER_CATALOGUE, getProviderDefinition, type ProviderRow } from '../services/speech-providers.js'

function row(over: Partial<ProviderRow>): ProviderRow {
  const providerId = over.providerId ?? 'openai_realtime'
  const cat = getProviderDefinition(providerId)
  return {
    id: `cfg-${providerId}`,
    providerId,
    displayName: cat?.displayName ?? providerId,
    kind: (cat?.kind ?? 'realtime_s2s') as ProviderRow['kind'],
    enabled: true,
    priority: 100,
    preferredVoice: cat?.defaultVoice ?? null,
    preferredLocale: 'en-US',
    maxCostPerMinUsd: 0.5,
    maxLatencyMs: 1500,
    supportsStreaming: cat?.supportsStreaming ?? true,
    supportsInterruption: cat?.supportsInterruption ?? false,
    healthScore: 1.0,
    lastLatencyMs: cat?.typicalLatencyMs ?? null,
    lastError: null,
    lastHealthAt: null,
    hasKey: true,
    catalogue: cat,
    ...over,
  } as ProviderRow
}

describe('speech-router: realtime mode', () => {
  it('returns ok=false when no realtime providers configured', () => {
    const d = decideFromRows([row({ providerId: 'deepgram_stt' })], { mode: 'realtime' })
    expect(d.ok).toBe(false)
    expect(d.reason).toMatch(/no realtime/i)
  })

  it('picks the highest scoring realtime provider', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 1.0, lastLatencyMs: 400 }),
      row({ providerId: 'gemini_live',      healthScore: 0.6, lastLatencyMs: 900 }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime' })
    expect(d.ok).toBe(true)
    expect(d.primary).toBe('openai_realtime')
    expect(d.fallbackChain).toEqual(['gemini_live'])
  })

  it('failover chain skips primary and orders remaining by score', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 1.0 }),
      row({ providerId: 'gemini_live',      healthScore: 0.8 }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime' })
    expect(d.fallbackChain).not.toContain(d.primary)
  })

  it('disabled providers are excluded', () => {
    const rows = [
      row({ providerId: 'openai_realtime', enabled: false }),
      row({ providerId: 'gemini_live',     enabled: true }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime' })
    expect(d.primary).toBe('gemini_live')
  })

  it('requireInterruption filters out non-interruption providers', () => {
    const rows = [
      row({ providerId: 'openai_realtime', supportsInterruption: true }),
      row({ providerId: 'custom', supportsInterruption: false, catalogue: { ...getProviderDefinition('custom')!, kind: 'realtime_s2s' } as any }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime', requireInterruption: true })
    expect(d.primary).toBe('openai_realtime')
  })

  it('locale filter drops providers without matching locale (when catalogue locales are non-empty)', () => {
    const rows = [
      row({ providerId: 'cartesia_tts', kind: 'realtime_s2s' as any }),  // cartesia catalogue locales = ['en-US']
    ]
    const d = decideFromRows(rows, { mode: 'realtime', locale: 'ja-JP' })
    expect(d.ok).toBe(false)
  })
})

describe('speech-router: fallback mode (STT→Brain→TTS)', () => {
  it('requires both STT and TTS', () => {
    const d1 = decideFromRows([row({ providerId: 'deepgram_stt' })], { mode: 'fallback' })
    expect(d1.ok).toBe(false)
    const d2 = decideFromRows([row({ providerId: 'elevenlabs' })], { mode: 'fallback' })
    expect(d2.ok).toBe(false)
  })

  it('pairs the best STT with the best TTS', () => {
    const rows = [
      row({ providerId: 'deepgram_stt',  healthScore: 1.0 }),
      row({ providerId: 'assemblyai_stt', healthScore: 0.5 }),
      row({ providerId: 'cartesia_tts',   healthScore: 1.0 }),
      row({ providerId: 'elevenlabs',     healthScore: 0.5 }),
    ]
    const d = decideFromRows(rows, { mode: 'fallback' })
    expect(d.ok).toBe(true)
    expect(d.pair?.stt).toBe('deepgram_stt')
    expect(d.pair?.tts).toBe('cartesia_tts')
    expect(d.primary).toBe('deepgram_stt+cartesia_tts')
  })

  it('emits a non-empty fallback chain when secondary providers exist', () => {
    const rows = [
      row({ providerId: 'deepgram_stt' }),
      row({ providerId: 'assemblyai_stt' }),
      row({ providerId: 'cartesia_tts' }),
      row({ providerId: 'elevenlabs' }),
    ]
    const d = decideFromRows(rows, { mode: 'fallback' })
    expect(d.fallbackChain.length).toBeGreaterThan(0)
  })
})

describe('speech-router: budget guard via maxCostPerMinUsd', () => {
  it('costFit penalizes providers exceeding budget', () => {
    const rows = [
      row({ providerId: 'openai_realtime' }),   // $0.30/min
      row({ providerId: 'gemini_live'      }),   // $0.25/min
    ]
    const tight = decideFromRows(rows, { mode: 'realtime', maxCostPerMinUsd: 0.26 })
    expect(tight.primary).toBe('gemini_live')   // openai exceeds, gemini fits
  })
})

describe('speech-router: invariants', () => {
  it('no provider id is hardcoded as the default', () => {
    expect(decideFromRows([], { mode: 'realtime' }).ok).toBe(false)
    expect(decideFromRows([], { mode: 'fallback' }).ok).toBe(false)
  })
  it('catalogue contains every required vendor family', () => {
    const ids = PROVIDER_CATALOGUE.map(p => p.id)
    for (const required of ['openai_realtime','gemini_live','elevenlabs','azure_speech','deepgram_stt','cartesia_tts','assemblyai_stt','playht','custom']) {
      expect(ids).toContain(required)
    }
  })
})

describe('speech-router: presets', () => {
  it('returns the requested preset by id', () => {
    expect(getPreset('security_mode').id).toBe('security_mode')
  })
  it('falls back to the first preset for unknown id', () => {
    expect(getPreset('does-not-exist').id).toBe(VOICE_PRESETS[0].id)
  })
  it('exposes 6 personality presets', () => {
    expect(VOICE_PRESETS.length).toBe(6)
  })
})
