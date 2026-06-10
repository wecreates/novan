/**
 * R610 — OpenAI voice fallback for OmniVoice (R599).
 *
 * When OmniVoice Studio isn't reachable from the droplet (current state since
 * the VPS can't host the diffusion models), voice.omni.tts and voice.omni.asr
 * transparently route to OpenAI's audio APIs using the OPENAI_API_KEY the
 * operator already wired.
 *
 * What gets a fallback:
 *   - TTS  → POST https://api.openai.com/v1/audio/speech (tts-1 + 6 voices)
 *   - ASR  → POST https://api.openai.com/v1/audio/transcriptions (whisper-1)
 *   - list_voices → returns the 6 OpenAI preset voices
 *   - health → returns ok if OPENAI_API_KEY is set + the SDK can reach OpenAI
 *
 * What does NOT fall back (because OpenAI doesn't offer it):
 *   - voice clone (3-sec sample → custom voice)  — error: "needs OmniVoice runtime"
 *   - video dubbing (URL → MP4)                  — error: "needs OmniVoice runtime"
 *
 * Voice ID mapping:
 *   OmniVoice profile UUIDs or aliases → OpenAI's alloy default.
 *   OpenAI aliases passed through verbatim: alloy, echo, fable, onyx, nova, shimmer.
 *   Operator may override with OPENAI_TTS_VOICE_DEFAULT env var.
 *
 * Records both successes and failures into R581 connector health under the
 * 'openai' connector id so the dashboard reflects the fallback in use.
 */
import { Buffer } from 'node:buffer'

const OPENAI_BASE = 'https://api.openai.com/v1'

const OPENAI_VOICE_ALIASES = new Set(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])

function resolveVoice(input?: string): string {
  const def = (process.env['OPENAI_TTS_VOICE_DEFAULT'] ?? 'alloy').toLowerCase()
  if (!input || input === 'default') return def
  const lower = input.toLowerCase()
  return OPENAI_VOICE_ALIASES.has(lower) ? lower : def
}

async function recordHealth(workspaceId: string | undefined, ok: boolean, err?: string): Promise<void> {
  if (!workspaceId) return
  try {
    const mod = await import('./r581-connector-health.js')
    if (ok) await mod.recordConnectorOk(workspaceId, 'openai')
    else    await mod.recordConnectorFail(workspaceId, 'openai', err ?? 'unknown')
  } catch { /* tolerated */ }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export async function openaiVoiceHealth(workspaceId?: string): Promise<{ ok: boolean; configured: boolean; reason?: string }> {
  if (!process.env['OPENAI_API_KEY']) return { ok: false, configured: false, reason: 'OPENAI_API_KEY not set' }
  try {
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${process.env['OPENAI_API_KEY']}` },
      signal: AbortSignal.timeout(8_000),
    })
    const ok = r.ok
    await recordHealth(workspaceId, ok, ok ? undefined : `models ${r.status}`)
    const result: { ok: boolean; configured: boolean; reason?: string } = { ok, configured: true }
    if (!ok) result.reason = `models ${r.status}`
    return result
  } catch (e) {
    const reason = (e as Error).message
    await recordHealth(workspaceId, false, reason)
    return { ok: false, configured: true, reason }
  }
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

export interface OpenAiTtsInput {
  text:    string
  voice?:  string
  format?: 'mp3' | 'wav' | 'flac' | 'opus' | 'aac' | 'pcm'
  model?:  'tts-1' | 'tts-1-hd'
  speed?:  number   // 0.25..4.0
}

export interface OpenAiTtsResult {
  audio:      Buffer
  mime:       string
  bytes:      number
  format:     string
  voice:      string
  model:      string
  durationMs: number
  provider:   'openai-fallback'
}

export async function openaiTts(input: OpenAiTtsInput, workspaceId?: string): Promise<OpenAiTtsResult> {
  if (!process.env['OPENAI_API_KEY']) throw new Error('OPENAI_API_KEY not set — cannot fall back')
  if (!input.text?.trim()) throw new Error('text required')
  const fmt = input.format ?? 'mp3'
  const voice = resolveVoice(input.voice)
  const model = input.model ?? 'tts-1'
  const t0 = Date.now()
  try {
    const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env['OPENAI_API_KEY']}`, 'content-type': 'application/json', accept: `audio/${fmt}` },
      body: JSON.stringify({
        model,
        input: input.text.slice(0, 4096),
        voice,
        response_format: fmt,
        speed: typeof input.speed === 'number' ? Math.max(0.25, Math.min(4.0, input.speed)) : 1.0,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      const err = `openai tts ${r.status} ${text.slice(0, 200)}`
      await recordHealth(workspaceId, false, err)
      throw new Error(err)
    }
    const ab = await r.arrayBuffer()
    const audio = Buffer.from(ab)
    await recordHealth(workspaceId, true)
    // Cost telemetry (tts-1 = $15/M chars, tts-1-hd = $30/M).
    try {
      const { recordAiUsage } = await import('./ai-usage.js')
      const rate = model === 'tts-1-hd' ? 30 : 15
      const cost = (input.text.length / 1_000_000) * rate
      await recordAiUsage({ workspaceId: workspaceId ?? 'default', source: 'voice.openai-fallback', provider: 'openai', model, inputTokens: input.text.length, outputTokens: 0, costUsd: cost })
    } catch { /* tolerated */ }
    return {
      audio, bytes: audio.length, format: fmt,
      mime: r.headers.get('content-type') ?? `audio/${fmt}`,
      voice, model, durationMs: Date.now() - t0, provider: 'openai-fallback',
    }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── ASR ─────────────────────────────────────────────────────────────────────

export interface OpenAiAsrInput {
  audio:     Buffer
  filename?: string
  language?: string
  prompt?:   string
  model?:    'whisper-1'
}

export interface OpenAiAsrResult {
  text:       string
  language?:  string
  durationMs: number
  provider:   'openai-fallback'
}

export async function openaiAsr(input: OpenAiAsrInput, workspaceId?: string): Promise<OpenAiAsrResult> {
  if (!process.env['OPENAI_API_KEY']) throw new Error('OPENAI_API_KEY not set — cannot fall back')
  if (!input.audio || input.audio.length === 0) throw new Error('audio buffer required')
  const t0 = Date.now()
  const fd = new FormData()
  const blob = new Blob([input.audio as unknown as ArrayBuffer], { type: 'audio/wav' })
  fd.append('file', blob, input.filename ?? 'audio.wav')
  fd.append('model', input.model ?? 'whisper-1')
  if (input.language) fd.append('language', input.language)
  if (input.prompt)   fd.append('prompt', input.prompt)
  try {
    const r = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env['OPENAI_API_KEY']}` },
      body: fd as unknown as BodyInit,
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      const err = `openai asr ${r.status} ${text.slice(0, 200)}`
      await recordHealth(workspaceId, false, err)
      throw new Error(err)
    }
    const body = await r.json() as { text?: string; language?: string }
    await recordHealth(workspaceId, true)
    try {
      const { recordAiUsage } = await import('./ai-usage.js')
      // whisper-1 = $0.006/min; we don't have duration here, use 1.5x the
      // file size in seconds as a rough proxy (wav at 16kHz mono ≈ 32KB/s).
      const secs = Math.max(1, Math.round(input.audio.length / 32_000))
      const cost = (secs / 60) * 0.006
      await recordAiUsage({ workspaceId: workspaceId ?? 'default', source: 'voice.openai-fallback', provider: 'openai', model: 'whisper-1', inputTokens: secs, outputTokens: 0, costUsd: cost })
    } catch { /* tolerated */ }
    const result: OpenAiAsrResult = { text: body.text ?? '', durationMs: Date.now() - t0, provider: 'openai-fallback' }
    if (body.language) result.language = body.language
    return result
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── Voice list ──────────────────────────────────────────────────────────────

export function openaiListVoices(): Array<{ id: string; name: string; language: string; preview_url?: string }> {
  return [
    { id: 'alloy',   name: 'Alloy',   language: 'multilingual' },
    { id: 'echo',    name: 'Echo',    language: 'multilingual' },
    { id: 'fable',   name: 'Fable',   language: 'multilingual' },
    { id: 'onyx',    name: 'Onyx',    language: 'multilingual' },
    { id: 'nova',    name: 'Nova',    language: 'multilingual' },
    { id: 'shimmer', name: 'Shimmer', language: 'multilingual' },
  ]
}
