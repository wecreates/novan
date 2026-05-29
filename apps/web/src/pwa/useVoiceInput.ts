/**
 * useVoiceInput.ts — Web Speech API wrapper for the mobile composer.
 *
 * SpeechRecognition is available on Chrome/Edge/Safari (incl. iOS),
 * not Firefox. Returns enough state to render a mic button + show
 * interim transcripts as the operator speaks.
 *
 * Honest scope:
 *   - On-device when the browser supports it; some platforms ship the
 *     audio to a cloud service. The mic icon should be visible during
 *     capture; we render a recording dot in the caller.
 *   - Continuous=false: one utterance per tap. Tap to start, auto-stops
 *     on silence. Tap again for another.
 *   - Interim results so the user sees their words appear live.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>
}
interface SpeechRecognitionLike extends EventTarget {
  lang:            string
  continuous:      boolean
  interimResults:  boolean
  maxAlternatives: number
  start():         void
  stop():          void
  abort():         void
  onresult:        ((e: SpeechRecognitionEventLike) => void) | null
  onerror:         ((e: Event & { error?: string }) => void) | null
  onend:           (() => void) | null
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?:        new () => SpeechRecognitionLike
    webkitSpeechRecognition?:  new () => SpeechRecognitionLike
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export interface VoiceInputState {
  supported:  boolean
  listening:  boolean
  interim:    string
  final:      string
  error:      string | null
  start:      () => void
  stop:       () => void
  reset:      () => void
}

export function useVoiceInput(lang: string = 'en-US'): VoiceInputState {
  const Ctor = useRef<(new () => SpeechRecognitionLike) | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const [supported, setSupported] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [final, setFinal] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Ctor.current = getSpeechRecognitionCtor()
    setSupported(!!Ctor.current)
  }, [])

  const start = useCallback((): void => {
    if (!Ctor.current) return
    try {
      const rec = new Ctor.current()
      rec.lang = lang
      rec.continuous = false
      rec.interimResults = true
      rec.maxAlternatives = 1
      rec.onresult = (e) => {
        let interimText = ''
        let finalText = ''
        for (let i = 0; i < e.results.length; i++) {
          const result = e.results[i]!
          const alt = result[0]!
          if (result.isFinal) finalText += alt.transcript
          else                interimText += alt.transcript
        }
        if (interimText) setInterim(interimText)
        if (finalText) {
          setFinal(prev => (prev + ' ' + finalText).trim())
          setInterim('')
        }
      }
      rec.onerror = (e) => {
        setError(e.error || 'speech recognition error')
        setListening(false)
      }
      rec.onend = () => {
        setListening(false)
        setInterim('')
      }
      recRef.current = rec
      setError(null)
      setListening(true)
      rec.start()
    } catch (e) {
      setError((e as Error).message)
      setListening(false)
    }
  }, [lang])

  const stop = useCallback((): void => {
    try { recRef.current?.stop() } catch { /* tolerated */ }
  }, [])

  const reset = useCallback((): void => {
    setFinal('')
    setInterim('')
    setError(null)
  }, [])

  return { supported, listening, interim, final, error, start, stop, reset }
}

/** Speak text out loud via SpeechSynthesis. Returns a cancel handle. */
export function speakText(text: string, opts?: { lang?: string; rate?: number; pitch?: number }): () => void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return () => {}
  // Cancel any in-flight utterance so we don't queue forever.
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  if (opts?.lang)  u.lang  = opts.lang
  if (opts?.rate)  u.rate  = opts.rate
  if (opts?.pitch) u.pitch = opts.pitch
  window.speechSynthesis.speak(u)
  return () => window.speechSynthesis.cancel()
}
