/**
 * voice-provider-adapter.ts — shared contract every vendor implements.
 *
 * A `VoiceProviderAdapter` describes how to:
 *   - mint a session (via the server's /api/v1/voice/realtime/session)
 *   - shape the WebSocket URL + subprotocols
 *   - parse vendor messages into a normalized `VoiceProviderEvent`
 *   - encode an outbound PCM16 frame into the vendor's wire format
 *
 * Once a vendor implements this contract, plugging it into the
 * `useRealtimeVoice` hook is one line.
 *
 * The two adapter skeletons below (Gemini Live + Deepgram) capture the
 * vendor-specific shape but stop short of full audio playback wiring —
 * that's the next focused turn per vendor.
 */

export type VoiceProviderEvent =
  | { kind: 'open' }
  | { kind: 'interim_transcript'; text: string }
  | { kind: 'final_transcript';   text: string }
  | { kind: 'assistant_text';     text: string }
  | { kind: 'assistant_audio';    pcm: Int16Array }
  | { kind: 'assistant_done' }
  | { kind: 'error';              message: string }
  | { kind: 'close';              reason: string }

export interface MintedSession {
  clientToken:       string
  providerSessionId: string
  url?:              string
  expiresAt:         number
  meta?:             Record<string, unknown>
}

export interface VoiceProviderAdapter {
  id: string
  /**
   * Given the minted session, return the WS URL + subprotocols the
   * `useVoiceWebSocket` hook should use to connect.
   */
  wsConfig(session: MintedSession): { url: string; protocols?: string | string[] }
  /**
   * Translate an incoming WS frame into a normalized event. Return
   * null for keep-alives / heartbeats / vendor-internal pings.
   */
  parseMessage(data: string | ArrayBuffer): VoiceProviderEvent | null
  /**
   * Wrap a PCM16 frame in the vendor's wire format. Returns either
   * an ArrayBuffer (binary frame) or a JSON-serializable object.
   */
  encodeAudio(pcm: Int16Array): ArrayBuffer | Record<string, unknown>
  /**
   * Optional: barge-in signal. Some vendors interrupt their own
   * response on a typed JSON message; others on closing the data
   * channel. Adapter decides.
   */
  bargeInPayload?(): Record<string, unknown> | null
}

// ─── Skeleton: Gemini Live ─────────────────────────────────────────────
// https://ai.google.dev/gemini-api/docs/live
// The Live API uses bidirectional `BidiGenerateContent` messages.
// Audio frames go in `realtime_input.media_chunks[].data` (base64).
// Transcripts arrive as `server_content.input_transcription.text` and
// `server_content.output_transcription.text`. Assistant audio arrives
// as `server_content.model_turn.parts[].inline_data` (base64 PCM).

import { pcm16ToBase64 } from './voice-audio-codec.js'

export const geminiLiveAdapter: VoiceProviderAdapter = {
  id: 'gemini_live',
  wsConfig(session) {
    const base = session.url ?? 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
    return { url: `${base}?access_token=${encodeURIComponent(session.clientToken)}` }
  },
  parseMessage(data) {
    if (typeof data !== 'string') return null    // Gemini sends JSON
    try {
      const msg = JSON.parse(data) as { serverContent?: { inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; turnComplete?: boolean; modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> } }; error?: { message?: string } }
      if (msg.error?.message) return { kind: 'error', message: msg.error.message }
      const sc = msg.serverContent
      if (sc?.inputTranscription?.text)  return { kind: 'interim_transcript', text: sc.inputTranscription.text }
      if (sc?.outputTranscription?.text) return { kind: 'assistant_text',     text: sc.outputTranscription.text }
      if (sc?.turnComplete)              return { kind: 'assistant_done' }
      return null
    } catch { return null }
  },
  encodeAudio(pcm) {
    // Gemini wants JSON: { realtime_input: { media_chunks: [{ mime_type, data }] } }
    return {
      realtime_input: {
        media_chunks: [{ mime_type: 'audio/pcm;rate=16000', data: pcm16ToBase64(pcm) }],
      },
    }
  },
  bargeInPayload() {
    // Sending an empty input turn signals interruption.
    return { client_content: { turn_complete: true, turns: [] } }
  },
}

// ─── Skeleton: Deepgram STT ───────────────────────────────────────────
// https://developers.deepgram.com/reference/streaming
// Deepgram accepts binary PCM frames directly and sends back JSON
// transcripts. Auth via Authorization header isn't possible in
// browsers; we pass the token as a subprotocol per their docs.

export const deepgramAdapter: VoiceProviderAdapter = {
  id: 'deepgram_stt',
  wsConfig(session) {
    const url = session.url ?? `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true`
    // Deepgram supports the "token" sec-websocket-protocol pattern.
    return { url, protocols: ['token', session.clientToken] }
  },
  parseMessage(data) {
    if (typeof data !== 'string') return null
    try {
      const msg = JSON.parse(data) as { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } }
      if (msg.type !== 'Results') return null
      const text = msg.channel?.alternatives?.[0]?.transcript?.trim()
      if (!text) return null
      return msg.is_final
        ? { kind: 'final_transcript',   text }
        : { kind: 'interim_transcript', text }
    } catch { return null }
  },
  encodeAudio(pcm) {
    // Deepgram wants raw PCM bytes. Copy into a fresh plain
    // ArrayBuffer so the return type is unambiguous and the view
    // offset on the wire is always zero.
    const ab = new ArrayBuffer(pcm.byteLength)
    new Uint8Array(ab).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
    return ab
  },
  bargeInPayload() {
    // STT has no audio to interrupt; sending a "Finalize" closes the
    // current segment cleanly.
    return { type: 'Finalize' }
  },
}

export const VOICE_ADAPTERS: Record<string, VoiceProviderAdapter> = {
  gemini_live:  geminiLiveAdapter,
  deepgram_stt: deepgramAdapter,
}

export function getAdapter(providerId: string): VoiceProviderAdapter | null {
  return VOICE_ADAPTERS[providerId] ?? null
}
