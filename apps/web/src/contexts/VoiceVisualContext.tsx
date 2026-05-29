/**
 * VoiceVisualContext — global voice-visual state + settings.
 *
 * One audio state engine lives here for the whole app so the bottom
 * equalizer, the brain pulse, the orbit rings, and the halo all read
 * the same amplitudes (no separate AudioContexts).
 *
 * Settings are persisted to localStorage per-workspace so a freshly-
 * loaded browser shows the operator's last choices immediately.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { useVoiceAudioState, type VoiceAudioState, type VoiceAudioController } from '../hooks/useVoiceAudioState.js'

// ─── Settings ──────────────────────────────────────────────────────────

export type VisualMode =
  | 'auto' | 'brain_pulse' | 'orbit_rings' | 'neural_wave'
  | 'voice_halo' | 'constellation' | 'equalizer' | 'off'

export type Intensity   = 'low' | 'medium' | 'high'
export type Performance = 'full' | 'balanced' | 'low_power'

export interface VoiceVisualSettings {
  mode:               VisualMode
  intensity:          Intensity
  performance:        Performance
  reducedMotion:      boolean
  disableFlicker:     boolean
  backgroundStars:    boolean
  equalizerEnabled:   boolean
}

const DEFAULTS: VoiceVisualSettings = {
  mode:             'auto',
  intensity:        'medium',
  performance:      'full',
  reducedMotion:    false,
  disableFlicker:   false,
  backgroundStars:  true,
  equalizerEnabled: true,
}

const STORAGE_KEY = 'novan:voice-visual-settings'

export function loadVoiceVisualSettings(): VoiceVisualSettings {
  if (typeof localStorage === 'undefined') return DEFAULTS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<VoiceVisualSettings>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

export function saveVoiceVisualSettings(s: VoiceVisualSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* */ }
}

// Reduce-motion auto-detection from the OS — respected unless the
// operator explicitly overrides via the controls.
function osPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ─── Context ───────────────────────────────────────────────────────────

interface VoiceVisualCtx {
  audio:    VoiceAudioState
  ctl:      VoiceAudioController
  settings: VoiceVisualSettings
  update:   (patch: Partial<VoiceVisualSettings>) => void
  reset:    () => void
  /** True when reduced-motion is on (either OS or operator setting). */
  motionReduced: boolean
  /** True when performance dictates we skip the heavier visualizers. */
  lowPower:      boolean
}

const Ctx = createContext<VoiceVisualCtx | null>(null)

export function VoiceVisualProvider({ children }: { children: React.ReactNode }) {
  const { state: audio, ctl } = useVoiceAudioState()
  const [settings, setSettings] = useState<VoiceVisualSettings>(() => loadVoiceVisualSettings())

  useEffect(() => { saveVoiceVisualSettings(settings) }, [settings])

  const update = (patch: Partial<VoiceVisualSettings>) =>
    setSettings(s => ({ ...s, ...patch }))
  const reset = () => setSettings(DEFAULTS)

  const value = useMemo<VoiceVisualCtx>(() => {
    const motionReduced = settings.reducedMotion || osPrefersReducedMotion()
    const lowPower      = settings.performance === 'low_power'
    return { audio, ctl, settings, update, reset, motionReduced, lowPower }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.amplitude, audio.lowFrequency, audio.midFrequency, audio.highFrequency,
      audio.logical, audio.isMuted, audio.isError, audio.needsApproval, audio.preview,
      settings])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useVoiceVisual(): VoiceVisualCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useVoiceVisual must be used inside <VoiceVisualProvider>')
  return c
}
