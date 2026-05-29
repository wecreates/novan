/**
 * useAudioCapture — browser-side microphone → PCM16 16 kHz frames.
 *
 * Sits between `getUserMedia` and any voice-provider adapter. Vendor
 * hooks (useGeminiLiveVoice, useDeepgramVoice) consume the frames this
 * hook produces — they never touch the mic directly. That isolation
 * lets the codec choices live in `voice-audio-codec.ts` and stay
 * unit-tested.
 *
 * Lifecycle:
 *   start() → getUserMedia → AudioContext → ScriptProcessor →
 *     downsample to 16 kHz → encode to PCM16 → call onFrame(pcm)
 *   stop()  → release everything
 *
 * Visible mic state is the caller's responsibility — this hook returns
 * `listening` for the UI to render an indicator. Per the directive's
 * "no hidden listening" rule, vendor hooks MUST render a recording
 * indicator while `listening` is true.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  downsampleTo16k, floatToPcm16, isSpeechFrame, VOICE_AUDIO_CONSTANTS,
} from './voice-audio-codec.js'

export interface AudioCaptureOptions {
  /** Called for each ~20 ms PCM16 frame. Drop silence yourself. */
  onFrame:    (pcm: Int16Array, meta: { isSpeech: boolean; rms: number }) => void
  /** Voice-activity threshold (RMS). Default 600 ≈ quiet office. */
  vadThreshold?: number
  /** Suppress silent frames before invoking onFrame. */
  suppressSilence?: boolean
  /** Optional callback when the mic fails to open. */
  onError?:   (msg: string) => void
}

export interface AudioCaptureState {
  supported:  boolean
  listening:  boolean
  start():    Promise<void>
  stop():     void
  lastError:  string | null
}

const supported = typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia
  && typeof window !== 'undefined'
  && typeof (window as unknown as { AudioContext?: unknown }).AudioContext !== 'undefined'

export function useAudioCapture(opts: AudioCaptureOptions): AudioCaptureState {
  const [listening, setListening] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const ctxRef       = useRef<AudioContext | null>(null)
  const sourceRef    = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const onFrameRef   = useRef(opts.onFrame); onFrameRef.current = opts.onFrame
  const onErrorRef   = useRef(opts.onError); onErrorRef.current = opts.onError
  const vadRef       = useRef(opts.vadThreshold ?? 600)
  const suppressRef  = useRef(!!opts.suppressSilence)

  const stop = useCallback(() => {
    try { processorRef.current?.disconnect() } catch { /* ignore */ }
    try { sourceRef.current?.disconnect() }    catch { /* ignore */ }
    try { ctxRef.current?.close() }            catch { /* ignore */ }
    streamRef.current?.getTracks().forEach(t => t.stop())
    processorRef.current = null
    sourceRef.current = null
    ctxRef.current = null
    streamRef.current = null
    setListening(false)
  }, [])

  const start = useCallback(async () => {
    if (!supported) {
      setLastError('audio capture not supported in this browser')
      onErrorRef.current?.('audio capture not supported')
      return
    }
    if (listening) return
    setLastError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 } })
      streamRef.current = stream
      // Constructor varies by browser; cast at the boundary.
      const Ctor = (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
                 ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctor()
      ctxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      sourceRef.current = source
      // ScriptProcessorNode is deprecated but still the most portable
      // way to get raw Float32 samples. AudioWorklet is the long-term
      // replacement; it requires a separate worker file the bundler
      // must serve, which we'll wire when the vendor hooks land.
      const proc = ctx.createScriptProcessor(2048, 1, 1)
      processorRef.current = proc
      const srcRate = ctx.sampleRate
      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0)
        const down  = downsampleTo16k(input, srcRate)
        const pcm   = floatToPcm16(down)
        const speech = isSpeechFrame(pcm, vadRef.current)
        if (suppressRef.current && !speech) return
        // RMS for the caller's UI (level meters / VAD chips).
        let sum = 0
        for (let i = 0; i < pcm.length; i++) { const s = pcm[i] ?? 0; sum += s * s }
        const rms = Math.sqrt(sum / Math.max(1, pcm.length))
        onFrameRef.current(pcm, { isSpeech: speech, rms })
      }
      source.connect(proc)
      proc.connect(ctx.destination)
      setListening(true)
    } catch (e) {
      const msg = (e as Error).message
      setLastError(msg)
      onErrorRef.current?.(msg)
      stop()
    }
  }, [listening, stop])

  useEffect(() => () => stop(), [stop])

  return { supported, listening, start, stop, lastError }
}

export { VOICE_AUDIO_CONSTANTS }
