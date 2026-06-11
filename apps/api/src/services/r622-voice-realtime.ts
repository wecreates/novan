/**
 * R622 — Realtime voice bridge (Advanced-Voice / Sesame parity).
 *
 * WS endpoint /ws/voice. Client streams Opus/WebM/PCM audio frames in;
 * server batches each turn, ships to R599 ASR (with R610 OpenAI fallback),
 * streams LLM response, sentence-by-sentence TTS back to the client.
 *
 * Wire-protocol:
 *   client→server  binary  audio chunk
 *   client→server  json    { type: 'config', mime, lang?, voice? }
 *   client→server  json    { type: 'end_turn' }
 *   client→server  json    { type: 'cancel' }     barge-in
 *   server→client  json    { type: 'hello', protocol, mime }
 *   server→client  json    { type: 'config_ack', cfg }
 *   server→client  json    { type: 'final_transcript', text }
 *   server→client  json    { type: 'assistant_delta', text }
 *   server→client  binary  audio frames (mp3)
 *   server→client  json    { type: 'done' }
 *   server→client  json    { type: 'error', message }
 *   server→client  json    { type: 'cancelled' }
 */
import { Buffer } from 'node:buffer'
import type { WebSocket } from 'ws'

interface SessionConfig {
  mime:       string
  lang?:      string
  voice?:     string
  workspaceId: string
}

interface VoiceSession {
  cfg:       SessionConfig
  audioBuf:  Buffer[]
  history:   Array<{ role: 'user' | 'assistant'; content: string }>
  cancelled: boolean
}

const SESSIONS = new WeakMap<WebSocket, VoiceSession>()
let activeCount = 0

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== 1) return
  try { ws.send(JSON.stringify(obj)) } catch { /* socket dying */ }
}

function sendBinary(ws: WebSocket, buf: Buffer): void {
  if (ws.readyState !== 1) return
  try { ws.send(buf) } catch { /* socket dying */ }
}

async function transcribeBatch(sess: VoiceSession): Promise<string> {
  if (sess.audioBuf.length === 0) return ''
  const audio = Buffer.concat(sess.audioBuf)
  sess.audioBuf = []
  const asrInput: Parameters<typeof import('./r599-omnivoice-provider.js').omniAsr>[0] = {
    audio,
    filename: sess.cfg.mime.includes('webm') ? 'turn.webm' : sess.cfg.mime.includes('mp4') ? 'turn.mp4' : 'turn.wav',
  }
  if (sess.cfg.lang) asrInput.language = sess.cfg.lang
  const { omniAsr } = await import('./r599-omnivoice-provider.js')
  const r = await omniAsr(asrInput, sess.cfg.workspaceId)
  return (r.text ?? '').trim()
}

async function speakSentence(ws: WebSocket, sess: VoiceSession, text: string): Promise<void> {
  if (sess.cancelled || !text) return
  try {
    const ttsInput: Parameters<typeof import('./r599-omnivoice-provider.js').omniTts>[0] = {
      text,
      format: 'mp3',
    }
    if (sess.cfg.voice) ttsInput.voice = sess.cfg.voice
    const { omniTts } = await import('./r599-omnivoice-provider.js')
    const r = await omniTts(ttsInput, sess.cfg.workspaceId) as unknown as { audioBase64?: string; audio_base64?: string }
    const b64 = r.audioBase64 ?? r.audio_base64
    if (b64 && !sess.cancelled) sendBinary(ws, Buffer.from(b64, 'base64'))
  } catch (e) {
    send(ws, { type: 'error', message: `tts: ${(e as Error).message}` })
  }
}

async function streamAssistant(ws: WebSocket, sess: VoiceSession): Promise<void> {
  const { streamChat } = await import('./chat-providers.js')
  const stream = streamChat(sess.cfg.workspaceId, [
    { role: 'system', content: 'You are Novan, the operator\'s autonomous AI partner. Be concise — this is voice. 1-3 sentences per turn unless asked for more. Acknowledge action items; do not narrate plans.' },
    ...sess.history,
  ], { skipUsageTracking: false })

  let full = ''
  let sentenceBuf = ''
  let next: IteratorResult<{ delta: string; done: boolean }, { tokens: number; costUsd: number; provider: string; model: string }>
  while (!(next = await stream.next()).done) {
    if (sess.cancelled) { try { await stream.return?.({} as never) } catch { /* ignore */ } return }
    const delta = next.value.delta
    if (!delta) continue
    full += delta
    sentenceBuf += delta
    send(ws, { type: 'assistant_delta', text: delta })
    const m = sentenceBuf.match(/^(.*?[.!?]['")\]]?)\s+/)
    if (m && m[1] && m[1].length > 4) {
      const sentence = m[1]
      sentenceBuf = sentenceBuf.slice(m[0].length)
      void speakSentence(ws, sess, sentence)
    }
  }
  if (sentenceBuf.trim().length > 0) await speakSentence(ws, sess, sentenceBuf.trim())
  sess.history.push({ role: 'assistant', content: full.trim() })
  send(ws, { type: 'done' })
}

export function attachVoiceSession(ws: WebSocket, workspaceId: string): void {
  const sess: VoiceSession = {
    cfg: { mime: 'audio/webm', workspaceId },
    audioBuf: [],
    history: [],
    cancelled: false,
  }
  SESSIONS.set(ws, sess)
  activeCount++
  send(ws, { type: 'hello', protocol: 'r622-voice/1', mime: 'audio/webm', voices: ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable'] })

  ws.on('message', async (data: Buffer | string, isBinary: boolean) => {
    const s = SESSIONS.get(ws); if (!s) return
    if (isBinary && Buffer.isBuffer(data)) {
      const total = s.audioBuf.reduce((acc, b) => acc + b.length, 0) + data.length
      if (total > 4 * 1024 * 1024) { send(ws, { type: 'error', message: 'turn too long (>4MB)' }); s.audioBuf = []; return }
      s.audioBuf.push(data)
      return
    }
    let msg: Record<string, unknown> = {}
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')) } catch { return }
    switch (msg['type']) {
      case 'config': {
        if (typeof msg['mime']  === 'string') s.cfg.mime  = msg['mime']  as string
        if (typeof msg['lang']  === 'string') s.cfg.lang  = msg['lang']  as string
        if (typeof msg['voice'] === 'string') s.cfg.voice = msg['voice'] as string
        send(ws, { type: 'config_ack', cfg: s.cfg })
        return
      }
      case 'end_turn': {
        s.cancelled = false
        try {
          const transcript = await transcribeBatch(s)
          send(ws, { type: 'final_transcript', text: transcript })
          if (!transcript) { send(ws, { type: 'done' }); return }
          s.history.push({ role: 'user', content: transcript })
          await streamAssistant(ws, s)
        } catch (e) {
          send(ws, { type: 'error', message: (e as Error).message })
        }
        return
      }
      case 'cancel': {
        s.cancelled = true
        s.audioBuf = []
        send(ws, { type: 'cancelled' })
        return
      }
      default:
        send(ws, { type: 'error', message: `unknown message type: ${String(msg['type'])}` })
    }
  })

  ws.on('close', () => { SESSIONS.delete(ws); activeCount = Math.max(0, activeCount - 1) })
  ws.on('error', () => { SESSIONS.delete(ws); activeCount = Math.max(0, activeCount - 1) })
}

export function voiceStats(): { activeSessions: number } {
  return { activeSessions: activeCount }
}
