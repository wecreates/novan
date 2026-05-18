/**
 * audio.ts — Subtle interface tones, opt-in only.
 *
 * Honest scope:
 *   - All tones are short (~80-200ms), low amplitude, single oscillator
 *   - Default off — operator opts in via Sound dropdown
 *   - Respects prefers-reduced-motion (treats as "audio off too")
 *   - No music, no sci-fi cliché spam, no spatial 3D audio
 *   - WebAudio only, no asset downloads
 */

type ToneKind = 'select' | 'open' | 'confirm' | 'reject' | 'critical' | 'success'

interface ToneSpec {
  freq:    number       // Hz
  duration: number      // ms
  type:    OscillatorType
  gain:    number       // 0..1
  glide?:  number       // optional pitch glide target Hz
}

// Restrained palette — all minor pentatonic-ish so they feel coherent
const TONES: Record<ToneKind, ToneSpec> = {
  select:   { freq: 523, duration: 60,  type: 'sine',     gain: 0.04 },   // C5
  open:     { freq: 392, duration: 90,  type: 'sine',     gain: 0.05, glide: 523 },   // G4→C5
  confirm:  { freq: 587, duration: 120, type: 'triangle', gain: 0.06 },   // D5
  reject:   { freq: 349, duration: 100, type: 'sine',     gain: 0.05, glide: 277 },   // F4→C#4 (downward)
  critical: { freq: 277, duration: 180, type: 'square',   gain: 0.05, glide: 220 },   // C#4 — restrained, low
  success:  { freq: 659, duration: 140, type: 'triangle', gain: 0.05 },   // E5
}

let ctx: AudioContext | null = null
let enabled = false

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    try {
      const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      ctx = new AC()
    } catch { return null }
  }
  return ctx
}

export function isAudioEnabled(): boolean {
  if (typeof window === 'undefined') return false
  // Reduced-motion users probably want silence too
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  if (!enabled) {
    enabled = localStorage.getItem('novan.audio') === 'on'
  }
  return enabled
}

export function setAudioEnabled(on: boolean): void {
  enabled = on
  if (typeof window !== 'undefined') localStorage.setItem('novan.audio', on ? 'on' : 'off')
  if (on) {
    // User gesture required to resume audio context; we'll attempt
    const c = ensureContext()
    if (c && c.state === 'suspended') c.resume().catch(() => null)
  }
}

export function tone(kind: ToneKind): void {
  if (!isAudioEnabled()) return
  const c = ensureContext()
  if (!c) return
  try {
    const spec = TONES[kind]
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = spec.type
    osc.frequency.setValueAtTime(spec.freq, c.currentTime)
    if (spec.glide) {
      osc.frequency.exponentialRampToValueAtTime(spec.glide, c.currentTime + spec.duration / 1000)
    }
    // Soft attack + release envelope (no clicks)
    gain.gain.setValueAtTime(0, c.currentTime)
    gain.gain.linearRampToValueAtTime(spec.gain, c.currentTime + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + spec.duration / 1000)

    osc.connect(gain)
    gain.connect(c.destination)
    osc.start()
    osc.stop(c.currentTime + spec.duration / 1000 + 0.05)
  } catch { /* silent fail */ }
}
