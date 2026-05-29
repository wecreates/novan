/**
 * useVoiceAudioState — single source of truth for voice-visual state.
 *
 * Owns:
 *   - Web Audio AnalyserNode wired to either the TTS playback element
 *     OR the operator's mic stream (when listening)
 *   - Smoothed amplitude (0..1) + low/mid/high band energies (0..1)
 *   - Logical state flags: isListening / isSpeaking / isThinking /
 *     isMuted / isError / needsApproval
 *   - Preview mode: synthetic sine wave for UI testing (clearly labeled
 *     in the controls; NEVER imitates "Novan is speaking")
 *
 * Honest scope:
 *   - We don't open the mic unless the caller explicitly asks. The hook
 *     consumes existing playback / capture surfaces; it doesn't request
 *     new permissions.
 *   - When no audio is attached, all amplitudes return 0. We never
 *     fabricate state.
 *
 * Performance:
 *   - Single rAF loop; pauses on `document.visibilitychange` → hidden
 *   - Disposes AudioContext + analyser on unmount
 *   - 64-bin FFT keeps CPU near zero
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'

export type VoiceLogicalState =
  | 'idle' | 'listening' | 'thinking' | 'speaking'
  | 'muted' | 'approval' | 'error'

export interface VoiceAudioFrame {
  amplitude:     number   // 0..1, RMS-smoothed
  lowFrequency:  number   // 0..1
  midFrequency:  number   // 0..1
  highFrequency: number   // 0..1
}

export interface VoiceAudioState extends VoiceAudioFrame {
  logical:            VoiceLogicalState
  isListening:        boolean
  isSpeaking:         boolean
  isThinking:         boolean
  isMuted:            boolean
  isError:            boolean
  needsApproval:      boolean
  providerLatency:    number | null
  currentVoiceProvider: string | null
  preview:            boolean    // true when synth amplitude is feeding the visuals
}

export interface VoiceAudioController {
  /** Attach an HTMLAudioElement (TTS playback) as the analyzer source. */
  attachElement:  (el: HTMLAudioElement | null) => void
  /** Attach a MediaStream (mic capture) as the analyzer source. */
  attachStream:   (stream: MediaStream | null) => void
  /** Detach all sources; amplitude returns to 0. */
  detach:         () => void
  /** Push logical-state hints from chat/voice services. */
  setLogical:     (s: VoiceLogicalState) => void
  setMuted:       (m: boolean) => void
  setError:       (e: boolean) => void
  setNeedsApproval: (a: boolean) => void
  /** Toggle preview mode (synthetic sine wave). */
  setPreview:     (p: boolean) => void
}

const FFT_SIZE = 64
const SMOOTHING = 0.7

// Default state — perfectly silent, idle.
const ZERO: VoiceAudioFrame = { amplitude: 0, lowFrequency: 0, midFrequency: 0, highFrequency: 0 }

export function useVoiceAudioState(): { state: VoiceAudioState; ctl: VoiceAudioController } {
  const [frame, setFrame] = useState<VoiceAudioFrame>(ZERO)
  const [logical, setLogical] = useState<VoiceLogicalState>('idle')
  const [muted, setMuted] = useState(false)
  const [errored, setErrored] = useState(false)
  const [approval, setApproval] = useState(false)
  const [preview, setPreview] = useState(false)

  // Persistent refs survive re-renders; the rAF loop reads from these.
  const ctxRef        = useRef<AudioContext | null>(null)
  const analyserRef   = useRef<AnalyserNode | null>(null)
  const sourceNodeRef = useRef<AudioNode | null>(null)
  const dataRef       = useRef<Uint8Array>(new Uint8Array(FFT_SIZE / 2))
  const rafRef        = useRef<number | null>(null)
  const previewRef    = useRef(false)
  const previewPhase  = useRef(0)

  // Keep the latest preview flag in a ref so the loop never restarts.
  useEffect(() => { previewRef.current = preview }, [preview])

  // Lazy AudioContext — created only when the first source attaches.
  const ensureCtx = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null
    if (ctxRef.current) return ctxRef.current
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = SMOOTHING
      ctxRef.current = ctx
      analyserRef.current = analyser
      dataRef.current = new Uint8Array(analyser.frequencyBinCount)
      return ctx
    } catch {
      return null
    }
  }, [])

  const detach = useCallback(() => {
    try { sourceNodeRef.current?.disconnect() } catch { /* */ }
    sourceNodeRef.current = null
  }, [])

  const attachElement = useCallback((el: HTMLAudioElement | null) => {
    detach()
    if (!el) return
    const ctx = ensureCtx()
    if (!ctx || !analyserRef.current) return
    try {
      const src = ctx.createMediaElementSource(el)
      src.connect(analyserRef.current)
      // Keep the audio audible — analyser is read-only branching.
      analyserRef.current.connect(ctx.destination)
      sourceNodeRef.current = src
    } catch { /* element may already be wired by another analyser */ }
  }, [detach, ensureCtx])

  const attachStream = useCallback((stream: MediaStream | null) => {
    detach()
    if (!stream) return
    const ctx = ensureCtx()
    if (!ctx || !analyserRef.current) return
    try {
      const src = ctx.createMediaStreamSource(stream)
      src.connect(analyserRef.current)
      // Do NOT connect to destination — that would feed mic to speakers.
      sourceNodeRef.current = src
    } catch { /* */ }
  }, [detach, ensureCtx])

  // The rAF loop: reads analyser bins, splits into low/mid/high, smooths.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let alive = true
    let last = ZERO

    const tick = () => {
      if (!alive) return

      // Pause when the tab is hidden — visuals don't need to update,
      // and Chrome throttles us anyway.
      if (document.visibilityState === 'hidden') {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      let next: VoiceAudioFrame
      if (previewRef.current) {
        // Synthetic sine wave for preview ONLY. Slowly varying so the
        // UI looks alive but unmistakably non-speech.
        previewPhase.current = (previewPhase.current + 0.012) % (Math.PI * 2)
        const a = 0.35 + 0.25 * Math.sin(previewPhase.current)
        next = {
          amplitude:     a,
          lowFrequency:  0.4 + 0.3 * Math.sin(previewPhase.current * 0.6),
          midFrequency:  0.5 + 0.25 * Math.sin(previewPhase.current * 1.0 + 1),
          highFrequency: 0.3 + 0.25 * Math.sin(previewPhase.current * 1.4 + 2),
        }
      } else if (analyserRef.current && sourceNodeRef.current) {
        // Cast through `as never` to satisfy newer DOM types that
        // expect Uint8Array<ArrayBuffer>; our buffer is a real
        // ArrayBuffer at runtime (the constructor allocates one).
        analyserRef.current.getByteFrequencyData(dataRef.current as never)
        const bins = dataRef.current
        const len = bins.length
        let lo = 0, mi = 0, hi = 0
        const loEnd = Math.floor(len * 0.20)
        const miEnd = Math.floor(len * 0.55)
        for (let i = 0; i < len; i++) {
          if      (i < loEnd) lo += bins[i] ?? 0
          else if (i < miEnd) mi += bins[i] ?? 0
          else                hi += bins[i] ?? 0
        }
        const loN = lo / Math.max(1, loEnd) / 255
        const miN = mi / Math.max(1, miEnd - loEnd) / 255
        const hiN = hi / Math.max(1, len - miEnd) / 255
        const amp = Math.min(1, (loN + miN + hiN) / 3)
        // Soft lerp to last for cinematic motion.
        const a = last.amplitude     * 0.55 + amp * 0.45
        next = {
          amplitude:     a,
          lowFrequency:  last.lowFrequency  * 0.55 + loN * 0.45,
          midFrequency:  last.midFrequency  * 0.55 + miN * 0.45,
          highFrequency: last.highFrequency * 0.55 + hiN * 0.45,
        }
      } else {
        // No source, no preview → decay to zero.
        next = {
          amplitude:     last.amplitude     * 0.85,
          lowFrequency:  last.lowFrequency  * 0.85,
          midFrequency:  last.midFrequency  * 0.85,
          highFrequency: last.highFrequency * 0.85,
        }
      }
      // Only call setState when the value moved meaningfully — avoids
      // re-rendering subscribers 60 times/sec on idle.
      if (Math.abs(next.amplitude - last.amplitude) > 0.005 ||
          Math.abs(next.lowFrequency - last.lowFrequency) > 0.01 ||
          Math.abs(next.midFrequency - last.midFrequency) > 0.01 ||
          Math.abs(next.highFrequency - last.highFrequency) > 0.01) {
        setFrame(next)
        last = next
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Cleanup AudioContext on unmount
  useEffect(() => {
    return () => {
      try { sourceNodeRef.current?.disconnect() } catch { /* */ }
      try { analyserRef.current?.disconnect() } catch { /* */ }
      try { ctxRef.current?.close() } catch { /* */ }
    }
  }, [])

  const ctl = useMemo<VoiceAudioController>(() => ({
    attachElement,
    attachStream,
    detach,
    setLogical,
    setMuted,
    setError: setErrored,
    setNeedsApproval: setApproval,
    setPreview,
  }), [attachElement, attachStream, detach])

  const state: VoiceAudioState = {
    ...frame,
    logical,
    isListening:   logical === 'listening',
    isSpeaking:    logical === 'speaking',
    isThinking:    logical === 'thinking',
    isMuted:       muted,
    isError:       errored,
    needsApproval: approval,
    providerLatency:      null,
    currentVoiceProvider: null,
    preview,
  }

  return { state, ctl }
}
