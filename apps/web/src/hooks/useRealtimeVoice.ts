/**
 * useRealtimeVoice — opens a native realtime audio pipe to a provider via
 * the server-minted ephemeral token, bypassing the browser's built-in
 * SpeechRecognition + speechSynthesis.
 *
 * Currently implements the OpenAI Realtime WebRTC handshake; Gemini Live
 * and Deepgram are WebSocket-based and land in subsequent iterations.
 *
 * Provider-agnostic from the caller's perspective: the hook asks the
 * backend for a session via `POST /api/v1/voice/realtime/session` and
 * dispatches on the returned `url`. Audio plays from a hidden <audio>
 * element the hook attaches to the page; transcripts arrive over the
 * data channel (server.event events) and are forwarded to onFinal /
 * onInterim callbacks identical in shape to useSpeechRecognition.
 *
 * Privacy: raw audio frames go browser↔vendor directly. The server only
 * sees mint + barge-in control-plane traffic.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export interface RealtimeOptions {
  workspaceId: string
  providerId:  string                       // 'openai_realtime' | 'gemini_live' | 'deepgram_stt' | 'custom'
  sessionId?:  string                       // optional voice_session_id for audit
  locale?:     string
  voice?:      string
  bargeInEnabled?: boolean
  onInterim?: (text: string) => void
  onFinal?:   (text: string) => void
  onAssistantSpeechStart?: () => void
  onAssistantSpeechEnd?:   () => void
  onError?:   (msg: string) => void
}

export interface RealtimeState {
  supported:        boolean
  connecting:       boolean
  connected:        boolean
  providerSessionId: string | null
  connect():        Promise<void>
  disconnect():     void
  bargeIn():        Promise<void>
  /** True while the assistant is producing audio output. */
  assistantSpeaking: boolean
  lastError:        string | null
}

interface MintedSession { clientToken: string; providerSessionId: string; url?: string; expiresAt: number; meta?: Record<string, unknown> }

const supportsWebRTC = typeof window !== 'undefined'
  && typeof RTCPeerConnection !== 'undefined'
  && typeof navigator !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia

export function useRealtimeVoice(opts: RealtimeOptions): RealtimeState {
  const [connecting, setConnecting] = useState(false)
  const [connected,  setConnected]  = useState(false)
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null)
  const [assistantSpeaking, setAssistantSpeaking] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const pcRef     = useRef<RTCPeerConnection | null>(null)
  const dcRef     = useRef<RTCDataChannel | null>(null)
  const audioRef  = useRef<HTMLAudioElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const onsRef    = useRef(opts); onsRef.current = opts

  const teardown = useCallback(() => {
    try { dcRef.current?.close()      } catch { /* ignore */ }
    try { pcRef.current?.close()      } catch { /* ignore */ }
    streamRef.current?.getTracks().forEach(t => t.stop())
    audioRef.current?.remove()
    pcRef.current = null; dcRef.current = null; streamRef.current = null; audioRef.current = null
    setConnected(false); setConnecting(false); setAssistantSpeaking(false); setProviderSessionId(null)
  }, [])

  const disconnect = useCallback(() => teardown(), [teardown])

  const bargeIn = useCallback(async () => {
    // Two paths: send response.cancel on the data channel (real-time stop)
    // AND post to the server endpoint for the audit trail.
    try { dcRef.current?.send(JSON.stringify({ type: 'response.cancel' })) } catch { /* ignore */ }
    try {
      await fetch(`/api/v1/voice/realtime/${encodeURIComponent(opts.providerId)}/barge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: opts.workspaceId,
          provider_session_id: providerSessionId,
          voice_session_id:    opts.sessionId ?? null,
        }),
      })
    } catch { /* ignore */ }
    setAssistantSpeaking(false)
  }, [opts.providerId, opts.workspaceId, opts.sessionId, providerSessionId])

  const connect = useCallback(async () => {
    if (!supportsWebRTC) { setLastError('WebRTC not supported in this browser'); return }
    if (connecting || connected) return
    setLastError(null); setConnecting(true)

    try {
      // 1. Mint an ephemeral session server-side
      const mintRes = await fetch('/api/v1/voice/realtime/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: opts.workspaceId,
          provider_id:  opts.providerId,
          ...(opts.locale ? { locale: opts.locale } : {}),
          ...(opts.voice  ? { voice:  opts.voice  } : {}),
          ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
        }),
      })
      if (!mintRes.ok) {
        const j = await mintRes.json().catch(() => ({} as { error?: string }))
        throw new Error(j.error ?? `mint failed with ${mintRes.status}`)
      }
      const minted = (await mintRes.json() as { data: MintedSession }).data
      setProviderSessionId(minted.providerSessionId)

      // 2. WebRTC pipe — currently only OpenAI Realtime uses SDP exchange.
      if (opts.providerId !== 'openai_realtime') {
        throw new Error(`provider ${opts.providerId} requires WebSocket transport — not yet wired in this hook`)
      }

      const pc = new RTCPeerConnection()
      pcRef.current = pc

      // Remote audio → hidden <audio> element for playback
      const el = document.createElement('audio'); el.autoplay = true; el.hidden = true
      document.body.appendChild(el)
      audioRef.current = el
      pc.ontrack = (ev) => { if (ev.streams[0]) el.srcObject = ev.streams[0] }

      // Local mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      for (const track of stream.getTracks()) pc.addTrack(track, stream)

      // Data channel for transcripts + control
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onopen = () => setConnected(true)
      dc.onclose = () => setConnected(false)
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as { type?: string; transcript?: string; delta?: string; text?: string }
          if (!msg.type) return
          // Operator transcript (input audio → text)
          if (msg.type === 'conversation.item.input_audio_transcription.completed' && (msg.transcript || msg.text)) {
            const final = (msg.transcript ?? msg.text ?? '').trim()
            if (final) onsRef.current.onFinal?.(final)
          }
          if (msg.type === 'conversation.item.input_audio_transcription.delta' && msg.delta) {
            onsRef.current.onInterim?.(msg.delta)
          }
          // Assistant speaking lifecycle
          if (msg.type === 'response.audio.delta' && !assistantSpeaking) {
            setAssistantSpeaking(true); onsRef.current.onAssistantSpeechStart?.()
          }
          if (msg.type === 'response.audio.done' || msg.type === 'response.done') {
            setAssistantSpeaking(false); onsRef.current.onAssistantSpeechEnd?.()
          }
        } catch { /* non-JSON events are ignored */ }
      }

      // SDP offer → exchange via OpenAI's realtime endpoint with our ephemeral token
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const base = minted.url ?? 'https://api.openai.com/v1/realtime'
      const sdpRes = await fetch(`${base}?model=gpt-4o-realtime-preview`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${minted.clientToken}`,
          'Content-Type':  'application/sdp',
        },
        body: offer.sdp ?? '',
      })
      if (!sdpRes.ok) throw new Error(`SDP exchange failed: ${sdpRes.status}`)
      const answerSdp = await sdpRes.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      setConnecting(false)
    } catch (e) {
      const msg = (e as Error).message
      setLastError(msg)
      onsRef.current.onError?.(msg)
      teardown()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.workspaceId, opts.providerId, opts.locale, opts.voice, opts.sessionId, connecting, connected])

  // Tear down on unmount
  useEffect(() => () => teardown(), [teardown])

  return {
    supported: supportsWebRTC,
    connecting, connected, providerSessionId,
    connect, disconnect, bargeIn,
    assistantSpeaking, lastError,
  }
}
