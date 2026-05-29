/**
 * useSpeechRecognition — thin wrapper around the browser's Web Speech
 * API (window.SpeechRecognition / webkitSpeechRecognition).
 *
 * Streams partial + final transcripts. Final transcripts fire the
 * supplied onFinal callback so the caller can route them through the
 * voice /command pipeline.
 *
 * Why browser STT instead of a provider WebRTC pipe?
 *   - Zero round-trip; works offline-ish on Chrome.
 *   - No raw audio crosses our backend, simplifying privacy.
 *   - The /command pipeline already accepts text — the conversation
 *     layer behaves identically whether the transcript came from voice
 *     or the input box.
 * The Voice Provider Router still drives TTS playback; this hook just
 * captures the operator's speech end-to-end inside the browser.
 *
 * Caller responsibilities:
 *   - Display a visible recording indicator while `listening` is true.
 *   - Respect `onSpeechStart` to barge-in (cancel current TTS).
 *   - Stop on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface SpeechRecognitionLike {
  start(): void
  stop(): void
  abort(): void
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean; length: number }> }) => void) | null
  onerror: ((ev: { error: string }) => void) | null
  onend: (() => void) | null
  onspeechstart: (() => void) | null
}

interface SpeechRecognitionCtor { new(): SpeechRecognitionLike }

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface UseSpeechRecognitionOptions {
  /** BCP-47 locale, e.g. 'en-US'. */
  locale?: string
  /** Continuous listening — survives short pauses. */
  continuous?: boolean
  /** Called for every interim result. */
  onInterim?: (text: string) => void
  /** Called when a final segment is recognized. */
  onFinal?: (text: string) => void
  /** Called when the engine detects the operator started speaking. */
  onSpeechStart?: () => void
  /** Called when the engine ends (auto-restarts if `continuous` and started). */
  onEnd?: () => void
  /** Called on engine error. */
  onError?: (err: string) => void
}

export interface UseSpeechRecognitionResult {
  supported:    boolean
  listening:    boolean
  interim:      string
  start():      void
  stop():       void
  abort():      void
  lastError:    string | null
}

export function useSpeechRecognition(opts: UseSpeechRecognitionOptions = {}): UseSpeechRecognitionResult {
  const { locale = 'en-US', continuous = true, onInterim, onFinal, onSpeechStart, onEnd, onError } = opts
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const startedRef = useRef(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim]     = useState('')
  const [lastError, setLastError] = useState<string | null>(null)
  const Ctor = getCtor()
  const supported = !!Ctor

  // Stable callback refs so we never recreate the engine on every render
  const onFinalRef        = useRef(onFinal); onFinalRef.current = onFinal
  const onInterimRef      = useRef(onInterim); onInterimRef.current = onInterim
  const onSpeechStartRef  = useRef(onSpeechStart); onSpeechStartRef.current = onSpeechStart
  const onEndRef          = useRef(onEnd); onEndRef.current = onEnd
  const onErrorRef        = useRef(onError); onErrorRef.current = onError

  useEffect(() => {
    if (!Ctor) return
    const rec = new Ctor()
    rec.continuous = continuous
    rec.interimResults = true
    rec.lang = locale
    rec.onresult = (ev) => {
      let interimText = ''
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i]!
        const text = r[0].transcript
        if (r.isFinal) {
          const finalText = text.trim()
          if (finalText) onFinalRef.current?.(finalText)
        } else {
          interimText += text
        }
      }
      setInterim(interimText.trim())
      if (interimText) onInterimRef.current?.(interimText.trim())
    }
    rec.onerror = (ev) => {
      setLastError(ev.error)
      onErrorRef.current?.(ev.error)
    }
    rec.onspeechstart = () => onSpeechStartRef.current?.()
    rec.onend = () => {
      setListening(false)
      onEndRef.current?.()
      // Auto-restart for continuous mode if the caller still wants us on.
      if (startedRef.current && continuous) {
        try { rec.start(); setListening(true) } catch { /* ignore */ }
      }
    }
    recRef.current = rec
    return () => { startedRef.current = false; try { rec.abort() } catch { /* ignore */ } }
  }, [Ctor, locale, continuous])

  const start = useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    try { rec.start(); startedRef.current = true; setListening(true); setLastError(null) }
    catch (e) { setLastError((e as Error).message) }
  }, [])
  const stop  = useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    startedRef.current = false
    try { rec.stop() } catch { /* ignore */ }
    setListening(false)
  }, [])
  const abort = useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    startedRef.current = false
    try { rec.abort() } catch { /* ignore */ }
    setListening(false); setInterim('')
  }, [])

  return { supported, listening, interim, start, stop, abort, lastError }
}

/** Cancel any in-flight TTS — used for barge-in when the operator speaks. */
export function cancelSpeech(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try { window.speechSynthesis.cancel() } catch { /* ignore */ }
}
