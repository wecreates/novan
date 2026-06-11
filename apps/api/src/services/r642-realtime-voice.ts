/**
 * R642c — OpenAI Realtime WebSocket pass-through (A1 true full-duplex).
 *
 * /ws/voice/realtime — operator's browser opens a WS to us, we open a
 * second WS to wss://api.openai.com/v1/realtime?model=gpt-realtime,
 * and proxy frames in both directions. OpenAI's Realtime API does ASR,
 * LLM, and TTS in one server-side pipeline with full barge-in support
 * and ~100ms latency, so we just stay out of the way.
 *
 * Frame protocol on the OpenAI side is documented at
 * https://platform.openai.com/docs/api-reference/realtime. We pass it
 * through verbatim — the client speaks the Realtime protocol directly
 * (including JSON events like session.update, input_audio_buffer.append,
 * response.create, etc.).
 *
 * Auth: requires OPENAI_API_KEY in env. Falls through to error close on
 * the client socket if missing or if OpenAI rejects.
 */
import { WebSocket as WsClient } from 'ws'
import type { WebSocket } from 'ws'

let activeCount = 0

function safeSend(ws: WebSocket, data: unknown, isBinary = false): void {
  if (ws.readyState !== 1) return
  try {
    if (isBinary && Buffer.isBuffer(data)) ws.send(data)
    else ws.send(typeof data === 'string' ? data : JSON.stringify(data))
  } catch { /* socket dying */ }
}

function closeBoth(client: WebSocket, upstream: WsClient | null, code: number, reason: string): void {
  try { client.close(code, reason) } catch { /* ignore */ }
  if (upstream) { try { upstream.close(code, reason) } catch { /* ignore */ } }
}

export function attachRealtimeSession(client: WebSocket, opts: { model?: string; voice?: string }): void {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    safeSend(client, { type: 'error', message: 'OPENAI_API_KEY not set on server' })
    try { client.close(1011, 'no api key') } catch { /* ignore */ }
    return
  }
  const model = opts.model ?? 'gpt-realtime'
  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`

  let upstream: WsClient | null = null
  try {
    upstream = new WsClient(upstreamUrl, {
      headers: {
        Authorization:    `Bearer ${apiKey}`,
        'OpenAI-Beta':    'realtime=v1',
        'User-Agent':     'Novan-R642c/1.0',
      },
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    })
  } catch (e) {
    safeSend(client, { type: 'error', message: `upstream connect failed: ${(e as Error).message}` })
    try { client.close(1011, 'upstream connect failed') } catch { /* ignore */ }
    return
  }

  activeCount++

  let upstreamReady = false
  const clientQueue: Array<Buffer | string> = []
  const drainClientQueue = (): void => {
    while (clientQueue.length > 0 && upstream && upstream.readyState === 1) {
      const m = clientQueue.shift()
      if (m == null) break
      try { upstream.send(m) } catch { /* dying */ }
    }
  }

  upstream.on('open', () => {
    upstreamReady = true
    safeSend(client, { type: 'novan.upstream_ready', model, voice: opts.voice ?? 'alloy' })
    // If operator passed ?voice=… as a query param, send a session.update with that voice.
    if (opts.voice) {
      safeSend(upstream!, {
        type: 'session.update',
        session: { voice: opts.voice },
      })
    }
    drainClientQueue()
  })

  upstream.on('message', (data, isBinary) => {
    if (isBinary && Buffer.isBuffer(data)) {
      safeSend(client, data, true)
    } else {
      const str = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      safeSend(client, str)
    }
  })
  upstream.on('error', (e) => {
    safeSend(client, { type: 'error', source: 'upstream', message: (e as Error).message })
  })
  upstream.on('close', (code, reason) => {
    closeBoth(client, null, code === 1006 ? 1011 : code, `upstream closed: ${reason?.toString() ?? ''}`.slice(0, 100))
    activeCount = Math.max(0, activeCount - 1)
  })

  client.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (!upstream) return
    if (!upstreamReady || upstream.readyState !== 1) {
      // Queue up to ~1 MB while waiting for upstream open
      const queueSize = clientQueue.reduce((acc, m) => acc + (typeof m === 'string' ? m.length : m.length), 0)
      if (queueSize > 1024 * 1024) return  // drop overflow
      clientQueue.push(isBinary && Buffer.isBuffer(data) ? data : (typeof data === 'string' ? data : data.toString('utf8')))
      return
    }
    if (isBinary && Buffer.isBuffer(data)) {
      try { upstream.send(data) } catch { /* dying */ }
    } else {
      const str = typeof data === 'string' ? data : data.toString('utf8')
      try { upstream.send(str) } catch { /* dying */ }
    }
  })
  client.on('close', () => { if (upstream) try { upstream.close(1000) } catch { /* ignore */ }; activeCount = Math.max(0, activeCount - 1) })
  client.on('error', () => { if (upstream) try { upstream.close(1011) } catch { /* ignore */ }; activeCount = Math.max(0, activeCount - 1) })
}

export function realtimeStats(): { activeSessions: number } {
  return { activeSessions: activeCount }
}
