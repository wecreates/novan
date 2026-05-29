/**
 * useVoiceWebSocket — typed WebSocket connector for voice providers.
 *
 * Generic over the inbound message shape. The hook handles:
 *   - opening the WS with the ephemeral token returned by the
 *     server-side mint (`speech-provider-handlers.ts`)
 *   - one auto-reconnect attempt on unexpected close
 *   - typed send (binary + json)
 *   - close cleanup on unmount
 *
 * It does NOT decode vendor-specific protobuf or framing — that's the
 * job of the adapter (Gemini Live / Deepgram). The adapter wraps this
 * hook and translates between PCM frames + adapter-shaped messages.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error'

export interface VoiceWebSocketOptions<TMsg> {
  url:        string
  /** Optional subprotocol(s) — vendors like Deepgram pass the token here. */
  protocols?: string | string[]
  /** Parse an incoming WS message (string OR ArrayBuffer) into TMsg. */
  parse:      (data: string | ArrayBuffer) => TMsg | null
  onMessage?: (msg: TMsg) => void
  onOpen?:    () => void
  onClose?:   (ev: { code: number; reason: string; wasClean: boolean }) => void
  onError?:   (msg: string) => void
  /** Auto-reconnect once on unexpected close. Default true. */
  autoReconnect?: boolean
}

export interface VoiceWebSocketState {
  status:     WsStatus
  connect():  void
  disconnect(): void
  sendJson(msg: unknown): boolean
  sendBinary(buf: ArrayBufferLike): boolean
  lastError:  string | null
}

export function useVoiceWebSocket<TMsg>(opts: VoiceWebSocketOptions<TMsg>): VoiceWebSocketState {
  const [status, setStatus] = useState<WsStatus>('idle')
  const [lastError, setLastError] = useState<string | null>(null)
  const wsRef       = useRef<WebSocket | null>(null)
  const reconnectedRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const optsRef     = useRef(opts); optsRef.current = opts

  const disconnect = useCallback(() => {
    reconnectedRef.current = true   // prevent further auto-reconnect
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    try { wsRef.current?.close() } catch { /* ignore */ }
    wsRef.current = null
    setStatus('closed')
  }, [])

  const open = useCallback(() => {
    setStatus(prev => prev === 'idle' || prev === 'closed' ? 'connecting' : 'reconnecting')
    setLastError(null)
    let ws: WebSocket
    try {
      ws = optsRef.current.protocols
        ? new WebSocket(optsRef.current.url, optsRef.current.protocols)
        : new WebSocket(optsRef.current.url)
    } catch (e) {
      const msg = (e as Error).message
      setLastError(msg); setStatus('error')
      optsRef.current.onError?.(msg)
      return
    }
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('open')
      optsRef.current.onOpen?.()
    }
    ws.onmessage = (ev) => {
      try {
        const parsed = optsRef.current.parse(ev.data as string | ArrayBuffer)
        if (parsed != null) optsRef.current.onMessage?.(parsed)
      } catch (e) {
        optsRef.current.onError?.(`parse failure: ${(e as Error).message}`)
      }
    }
    ws.onerror = () => {
      setLastError('ws error')
      optsRef.current.onError?.('ws error')
    }
    ws.onclose = (ev) => {
      optsRef.current.onClose?.({ code: ev.code, reason: ev.reason, wasClean: ev.wasClean })
      const willReconnect = (optsRef.current.autoReconnect !== false)
                         && !reconnectedRef.current
                         && ev.code !== 1000   // normal closure
      if (willReconnect) {
        reconnectedRef.current = true
        setStatus('reconnecting')
        // Track the timer so disconnect()/unmount cancels the reopen
        // instead of firing on a torn-down hook.
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          open()
        }, 1000)
      } else {
        setStatus('closed')
      }
    }
  }, [])

  const connect = useCallback(() => {
    reconnectedRef.current = false
    open()
  }, [open])

  const sendJson = useCallback((msg: unknown): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try { ws.send(JSON.stringify(msg)); return true } catch { return false }
  }, [])

  const sendBinary = useCallback((buf: ArrayBufferLike): boolean => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try { ws.send(buf); return true } catch { return false }
  }, [])

  // Cleanup on unmount — cancel any pending reconnect timer too.
  useEffect(() => () => {
    reconnectedRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    try { wsRef.current?.close() } catch { /* ignore */ }
  }, [])

  return { status, connect, disconnect, sendJson, sendBinary, lastError }
}
