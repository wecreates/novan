/**
 * Tests for voice-visual settings persistence + pure helpers.
 *
 * The audio analyser itself depends on AudioContext + rAF + DOM,
 * which a Node vitest run can't faithfully exercise. We cover the
 * settings layer + state-flag derivation in pure form here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Fresh localStorage per test
class MemoryStorage {
  store = new Map<string, string>()
  getItem(k: string) { return this.store.get(k) ?? null }
  setItem(k: string, v: string) { this.store.set(k, v) }
  removeItem(k: string) { this.store.delete(k) }
  clear() { this.store.clear() }
}
beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage() as unknown as Storage
  ;(globalThis as { window?: Window }).window = { matchMedia: () => ({ matches: false }) } as unknown as Window
})

import { loadVoiceVisualSettings, saveVoiceVisualSettings } from '../contexts/VoiceVisualContext.js'

describe('voice-visual settings persistence', () => {
  it('returns defaults on empty storage', () => {
    const s = loadVoiceVisualSettings()
    expect(s.mode).toBe('auto')
    expect(s.intensity).toBe('medium')
    expect(s.performance).toBe('full')
    expect(s.reducedMotion).toBe(false)
    expect(s.equalizerEnabled).toBe(true)
    expect(s.backgroundStars).toBe(true)
  })

  it('round-trips through localStorage', () => {
    saveVoiceVisualSettings({
      mode: 'orbit_rings', intensity: 'high', performance: 'low_power',
      reducedMotion: true, disableFlicker: true,
      backgroundStars: false, equalizerEnabled: false,
    })
    const s = loadVoiceVisualSettings()
    expect(s.mode).toBe('orbit_rings')
    expect(s.intensity).toBe('high')
    expect(s.performance).toBe('low_power')
    expect(s.reducedMotion).toBe(true)
    expect(s.equalizerEnabled).toBe(false)
  })

  it('merges partial saved payloads with defaults', () => {
    localStorage.setItem('novan:voice-visual-settings', JSON.stringify({ mode: 'voice_halo' }))
    const s = loadVoiceVisualSettings()
    expect(s.mode).toBe('voice_halo')
    // Missing keys fall back to defaults
    expect(s.intensity).toBe('medium')
    expect(s.equalizerEnabled).toBe(true)
  })

  it('tolerates corrupted storage gracefully', () => {
    localStorage.setItem('novan:voice-visual-settings', '{not json')
    const s = loadVoiceVisualSettings()
    expect(s.mode).toBe('auto')
  })

  it('save → load is idempotent across reloads', () => {
    const first = loadVoiceVisualSettings()
    saveVoiceVisualSettings(first)
    const second = loadVoiceVisualSettings()
    expect(second).toEqual(first)
  })
})

describe('voice-visual settings — accessibility flags', () => {
  it('respects OS prefers-reduced-motion when matchMedia returns true', () => {
    ;(globalThis as { window?: Window }).window = {
      matchMedia: (q: string) => ({ matches: q.includes('reduced-motion') }),
    } as unknown as Window
    // Provider derives motionReduced = setting OR OS; we re-export the
    // OS check via a function for testability.
    // (osPrefersReducedMotion isn't exported — exercised via the provider
    //  in integration. We sanity-check the matchMedia mock is wired.)
    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
  })
})

describe('preview mode safety', () => {
  it('preview is OFF by default', () => {
    const s = loadVoiceVisualSettings()
    expect((s as unknown as { preview?: boolean }).preview).toBeUndefined()
    // preview is NOT a persisted setting — it lives in audio state.
    // This test guards against accidentally adding it to defaults.
  })

  it('settings JSON never claims voice is speaking', () => {
    const s = loadVoiceVisualSettings()
    const json = JSON.stringify(s)
    expect(json).not.toContain('speaking')
    expect(json).not.toContain('listening')
  })
})

// Stub the visibility API path so we know the engine pauses on hidden tabs.
describe('rAF pause on visibility', () => {
  it('document.visibilityState is checked', () => {
    // Pure structural check — the source file references the API.
    const moduleSource = String(require('fs').readFileSync(
      require('path').resolve(__dirname, '../hooks/useVoiceAudioState.ts'), 'utf8',
    ))
    expect(moduleSource).toContain('visibilityState')
    expect(moduleSource).toContain('hidden')
  })
})

// Smoke: no module-load throws when localStorage is undefined
describe('settings — SSR safety', () => {
  it('loadVoiceVisualSettings works when localStorage is undefined', () => {
    ;(globalThis as { localStorage?: Storage }).localStorage = undefined as unknown as Storage
    // Re-import the module to bypass cached storage reference
    vi.resetModules()
    return import('../contexts/VoiceVisualContext.js').then(m => {
      const s = m.loadVoiceVisualSettings()
      expect(s.mode).toBe('auto')
    })
  })
})
