/**
 * R682 — Voice-in → text-out round trip.
 *
 * One-shot helper for the PWA voice-button: takes audio, transcribes via
 * R677, feeds the transcript through R663 chat (with R655 session reuse),
 * returns transcript + assistant reply. Optionally TTS-replies via R668
 * so the caller gets back both text and an audio assetId.
 */
import { transcribe } from './r677-openai-whisper.js'
import { chat } from './r663-novan-chat.js'
import { speak } from './r668-openai-tts.js'

export interface VoiceChatInput {
  /** One of audioUrl, audioB64, or assetId */
  audioUrl?:    string
  audioB64?:    string
  audioAssetId?: string
  /** Optional existing chat session to continue */
  sessionId?:   string
  /** Bias decoding (operator name, jargon) */
  transcribePrompt?: string
  /** Force/skip TTS reply (default true if OPENAI_API_KEY present) */
  ttsReply?:    boolean
  ttsVoice?:    'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage'
  language?:    string
}

export interface VoiceChatResult {
  ok:         boolean
  transcript?: string
  reply?:     string
  sessionId?: string
  ttsAssetId?: string
  ttsUrl?:    string
  costUsd:    number
  latencyMs:  number
  error?:     string
  steps?:     { transcribe: { ms: number; ok: boolean }; chat: { ms: number; ok: boolean }; tts?: { ms: number; ok: boolean } }
}

export async function voiceChat(workspaceId: string, input: VoiceChatInput): Promise<VoiceChatResult> {
  const t0 = Date.now()
  if (!input.audioUrl && !input.audioB64 && !input.audioAssetId) {
    return { ok: false, error: 'one of audioUrl, audioB64, audioAssetId required', costUsd: 0, latencyMs: 0 }
  }

  // 1. Whisper
  const tx0 = Date.now()
  const transcribeInput: Parameters<typeof transcribe>[1] = {}
  if (input.audioUrl)         transcribeInput.audioUrl = input.audioUrl
  if (input.audioB64)         transcribeInput.audioB64 = input.audioB64
  if (input.audioAssetId)     transcribeInput.assetId  = input.audioAssetId
  if (input.language)         transcribeInput.language = input.language
  if (input.transcribePrompt) transcribeInput.prompt   = input.transcribePrompt
  const tx = await transcribe(workspaceId, transcribeInput)
  const txMs = Date.now() - tx0
  if (!tx.ok || !tx.text?.trim()) {
    return {
      ok: false,
      error: tx.error ?? 'empty transcript',
      transcript: tx.text ?? '',
      costUsd: tx.costUsd,
      latencyMs: Date.now() - t0,
      steps: { transcribe: { ms: txMs, ok: false }, chat: { ms: 0, ok: false } },
    }
  }

  // 2. Chat
  const ch0 = Date.now()
  const chatInput: Parameters<typeof chat>[1] = { message: tx.text.trim() }
  if (input.sessionId) chatInput.sessionId = input.sessionId
  const ch = await chat(workspaceId, chatInput)
  const chMs = Date.now() - ch0

  let totalCost = tx.costUsd + ch.costUsd
  const result: VoiceChatResult = {
    ok: true,
    transcript: tx.text,
    reply: ch.answer,
    sessionId: ch.sessionId,
    costUsd: totalCost,
    latencyMs: Date.now() - t0,
    steps: { transcribe: { ms: txMs, ok: true }, chat: { ms: chMs, ok: true } },
  }

  // 3. Optional TTS reply
  const wantTts = input.ttsReply !== false && !!process.env['OPENAI_API_KEY']
  if (wantTts && ch.answer) {
    const ts0 = Date.now()
    const ttsInput: Parameters<typeof speak>[1] = { text: ch.answer }
    if (input.ttsVoice) ttsInput.voice = input.ttsVoice
    const ts = await speak(workspaceId, ttsInput)
    const tsMs = Date.now() - ts0
    if (ts.ok) {
      if (ts.assetId)   result.ttsAssetId = ts.assetId
      if (ts.publicUrl) result.ttsUrl     = ts.publicUrl
      totalCost += ts.costUsd
    }
    result.steps!.tts = { ms: tsMs, ok: ts.ok }
  }

  result.costUsd  = Number(totalCost.toFixed(6))
  result.latencyMs = Date.now() - t0
  return result
}
