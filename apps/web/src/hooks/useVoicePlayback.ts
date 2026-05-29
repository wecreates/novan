/**
 * useVoicePlayback — queue-and-play assistant turns through the
 *                    Coqui TTS sidecar.
 *
 * Behavior:
 *   - Only fires when the workspace has an active voice profile AND
 *     the sidecar reports reachable. If either is missing, this hook
 *     is a no-op and chat continues working in text-only.
 *   - Tries to keep the audio context warmed (browsers require a user
 *     gesture before playback; the first call from inside a click /
 *     keypress handler unlocks it).
 *   - Single-utterance queue — newer requests cancel older ones so
 *     the brain never overlaps with itself.
 *
 * Usage:
 *   const { speak, available, playing } = useVoicePlayback()
 *   useEffect(() => { if (assistantMessage) speak(assistantMessage) }, [assistantMessage])
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { useVoiceVisual } from '../contexts/VoiceVisualContext.js'
import { api } from '../api.js'

interface ActiveProfile {
  hasActive: boolean
  language:  string
}

export interface VoicePlayback {
  /** True when a profile is active and the sidecar is reachable. */
  available: boolean
  /** True while an utterance is playing. */
  playing:   boolean
  /** Synthesize + play `text`. No-op when not available. */
  speak:     (text: string) => Promise<void>
  /** Stop any current playback. */
  stop:      () => void
}

export function useVoicePlayback(): VoicePlayback {
  const { workspaceId } = useWorkspace()
  const { ctl } = useVoiceVisual()
  const [playing, setPlaying] = useState(false)
  const audioRef    = useRef<HTMLAudioElement | null>(null)
  const abortRef    = useRef<AbortController | null>(null)

  // Lazy-create the audio element so SSR / non-DOM environments don't crash.
  // We also attach the element to the global voice analyzer so the
  // equalizer + halo + brain-pulse all see real amplitude.
  useEffect(() => {
    if (typeof Audio === 'undefined') return
    audioRef.current = new Audio()
    audioRef.current.crossOrigin = 'anonymous'
    audioRef.current.onplay  = () => { setPlaying(true);  ctl.setLogical('speaking') }
    audioRef.current.onended = () => { setPlaying(false); ctl.setLogical('idle') }
    audioRef.current.onerror = () => { setPlaying(false); ctl.setLogical('idle') }
    ctl.attachElement(audioRef.current)
    return () => { ctl.attachElement(null) }
  }, [ctl])

  // Cheap availability probe — sidecar health + presence of an active profile
  const probe = useQuery<{ data: ActiveProfile }>({
    queryKey: ['voice-playback-probe', workspaceId],
    queryFn:  async () => {
      const [health, profiles] = await Promise.all([
        api.get<{ data: { reachable: boolean } }>(`/api/v1/tts/sidecar/health`).catch(() => ({ data: { reachable: false } })),
        api.get<{ data: Array<{ isActive: boolean; language: string }> }>(`/api/v1/tts/profiles?workspace_id=${workspaceId}`).catch(() => ({ data: [] })),
      ])
      const active = profiles.data.find(p => p.isActive)
      return {
        data: {
          hasActive: Boolean(health.data.reachable && active),
          language:  active?.language ?? 'en',
        },
      }
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  })

  const available = Boolean(probe.data?.data?.hasActive)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
    }
    setPlaying(false)
  }, [])

  const speak = useCallback(async (text: string) => {
    if (!available || !text.trim() || !audioRef.current) return

    // Cancel any in-flight or playing utterance
    stop()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      setPlaying(true)
      const res = await fetch(`/api/v1/tts/synthesize`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ workspace_id: workspaceId, text }),
        signal:  ctrl.signal,
      })
      if (!res.ok) {
        setPlaying(false)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (!audioRef.current) return
      audioRef.current.src = url
      await audioRef.current.play().catch(() => { /* autoplay blocked → silent */ })
    } catch {
      setPlaying(false)
    }
  }, [available, workspaceId, stop])

  return { available, playing, speak, stop }
}
