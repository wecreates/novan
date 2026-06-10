/**
 * R599 — OmniVoice Studio provider adapter.
 *
 * Adds a self-hosted, zero-cost voice path to Novan alongside the paid PlayHT
 * + cloud TTS providers wired in earlier rounds. OmniVoice Studio is a local
 * Tauri+FastAPI app (https://github.com/debpalash/OmniVoice-Studio) that
 * exposes OpenAI-compat audio endpoints plus dubbing + voice-clone + ASR.
 *
 * Env:
 *   OMNIVOICE_BASE_URL    default http://localhost:8000
 *   OMNIVOICE_TIMEOUT_MS  default 60_000
 *   OMNIVOICE_TTS_BACKEND optional engine override (passed as `model` field)
 *
 * Endpoints used (OmniVoice 0.2.7):
 *   GET  /model/status                 — health + active engine
 *   GET  /v1/voices                    — list available voices/aliases
 *   POST /v1/audio/speech              — OpenAI-compat TTS (returns wav/mp3/flac/opus)
 *   POST /v1/audio/transcriptions      — OpenAI-compat ASR (multipart)
 *   POST /profiles                     — create voice profile (clone)
 *   POST /dub/ingest-url               — start a YouTube→dub job
 *   GET  /jobs/{id}                    — dub job status
 *
 * All operations register success/failure with R581 connector health for the
 * `omnivoice` connector id.
 */
import { Buffer } from 'node:buffer'

const BASE_URL_DEFAULT = 'http://localhost:8000'
const TIMEOUT_DEFAULT_MS = 60_000

// R610 — health cache + fallback gate. Voice ops check this before calling
// OmniVoice; on failure or when OmniVoice isn't configured/reachable, we
// transparently delegate to OpenAI via r610-openai-voice-fallback.
let _omniHealthCache: { ok: boolean; checkedAt: number } | null = null
const HEALTH_CACHE_MS = 60_000

async function shouldFallbackToOpenAi(): Promise<boolean> {
  if (!process.env['OPENAI_API_KEY']) return false   // no fallback target
  if (!process.env['OMNIVOICE_BASE_URL']) return true // OmniVoice not configured → use fallback
  // Cached health probe
  if (_omniHealthCache && (Date.now() - _omniHealthCache.checkedAt) < HEALTH_CACHE_MS) {
    return !_omniHealthCache.ok
  }
  try {
    const r = await fetch(`${baseUrl()}/model/status`, { method: 'GET', signal: AbortSignal.timeout(3_000) })
    _omniHealthCache = { ok: r.ok, checkedAt: Date.now() }
    return !r.ok
  } catch {
    _omniHealthCache = { ok: false, checkedAt: Date.now() }
    return true
  }
}

function baseUrl(): string {
  return (process.env['OMNIVOICE_BASE_URL'] ?? BASE_URL_DEFAULT).replace(/\/+$/, '')
}

function timeoutMs(): number {
  const n = Number(process.env['OMNIVOICE_TIMEOUT_MS'] ?? '')
  return Number.isFinite(n) && n > 0 ? n : TIMEOUT_DEFAULT_MS
}

async function omniFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? timeoutMs())
  try {
    return await fetch(`${baseUrl()}${path}`, { ...init, signal: ctrl.signal })
  } finally { clearTimeout(t) }
}

async function recordHealth(workspaceId: string | undefined, ok: boolean, err?: string): Promise<void> {
  if (!workspaceId) return
  try {
    const mod = await import('./r581-connector-health.js')
    if (ok) await mod.recordConnectorOk(workspaceId, 'omnivoice')
    else    await mod.recordConnectorFail(workspaceId, 'omnivoice', err ?? 'unknown')
  } catch { /* tolerated */ }
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface OmniHealth {
  ok:          boolean
  baseUrl:     string
  activeModel?:string
  loadedModels?: string[]
  voicesCount?:number
  error?:      string
}

export async function omniHealth(workspaceId?: string): Promise<OmniHealth> {
  // R610 — if OmniVoice not configured, surface the fallback state honestly
  if (!process.env['OMNIVOICE_BASE_URL'] && process.env['OPENAI_API_KEY']) {
    const { openaiVoiceHealth } = await import('./r610-openai-voice-fallback.js')
    const oa = await openaiVoiceHealth(workspaceId)
    const result: OmniHealth = { ok: oa.ok, baseUrl: 'openai-fallback', activeModel: 'tts-1', voicesCount: 6 }
    if (!oa.ok && oa.reason) result.error = `openai fallback: ${oa.reason}`
    return result
  }
  const result: OmniHealth = { ok: false, baseUrl: baseUrl() }
  try {
    const r = await omniFetch('/model/status', { method: 'GET', timeoutMs: 5_000 })
    if (!r.ok) throw new Error(`/model/status ${r.status}`)
    const body = await r.json() as { active_model?: string; loaded?: string[]; models?: Array<{ id: string }> }
    result.activeModel = body.active_model ?? body.models?.[0]?.id
    result.loadedModels = body.loaded ?? body.models?.map(m => m.id)
    try {
      const v = await omniFetch('/v1/voices', { method: 'GET', timeoutMs: 5_000 })
      if (v.ok) {
        const vj = await v.json() as { voices?: Array<unknown>; data?: Array<unknown> }
        result.voicesCount = (vj.voices ?? vj.data ?? []).length
      }
    } catch { /* tolerated */ }
    result.ok = true
    await recordHealth(workspaceId, true)
    return result
  } catch (e) {
    result.error = (e as Error).message
    await recordHealth(workspaceId, false, result.error)
    return result
  }
}

// ─── Voices ──────────────────────────────────────────────────────────────────

export interface OmniVoice { id: string; name?: string; language?: string; preview_url?: string }

export async function omniListVoices(workspaceId?: string): Promise<OmniVoice[]> {
  if (await shouldFallbackToOpenAi()) {
    const { openaiListVoices } = await import('./r610-openai-voice-fallback.js')
    return openaiListVoices() as OmniVoice[]
  }
  try {
    const r = await omniFetch('/v1/voices', { method: 'GET', timeoutMs: 10_000 })
    if (!r.ok) throw new Error(`/v1/voices ${r.status}`)
    const body = await r.json() as { voices?: OmniVoice[]; data?: OmniVoice[] }
    const list = body.voices ?? body.data ?? []
    await recordHealth(workspaceId, true)
    return list
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

export interface OmniTtsInput {
  text:           string
  voice?:         string   // alias or profile UUID
  language?:      string   // ISO 639-1
  speed?:         number   // 0.5..2
  format?:        'mp3' | 'wav' | 'flac' | 'opus'
  model?:         string   // engine override (e.g. 'omnivoice', 'cosyvoice', 'kittentts')
  instruct?:      string   // emotion / style instruction
}

export interface OmniTtsResult {
  audio:    Buffer
  mime:     string
  bytes:    number
  format:   string
  voice:    string
  durationMs: number
}

export async function omniTts(input: OmniTtsInput, workspaceId?: string): Promise<OmniTtsResult> {
  if (!input.text || !input.text.trim()) throw new Error('text required')
  // R610 — fall back to OpenAI TTS when OmniVoice isn't available
  if (await shouldFallbackToOpenAi()) {
    const { openaiTts } = await import('./r610-openai-voice-fallback.js')
    const ttsInput: Parameters<typeof openaiTts>[0] = { text: input.text }
    if (input.voice)  ttsInput.voice  = input.voice
    if (input.format) ttsInput.format = input.format as 'mp3' | 'wav' | 'flac' | 'opus'
    if (typeof input.speed === 'number') ttsInput.speed = input.speed
    const r = await openaiTts(ttsInput, workspaceId)
    return {
      audio: r.audio, mime: r.mime, bytes: r.bytes, format: r.format,
      voice: r.voice, durationMs: r.durationMs,
    }
  }
  const fmt = input.format ?? 'mp3'
  const model = input.model ?? process.env['OMNIVOICE_TTS_BACKEND'] ?? 'omnivoice'
  const body = {
    model,
    input: input.text.slice(0, 8000),
    voice: input.voice ?? 'default',
    response_format: fmt,
    speed: input.speed ?? 1.0,
    ...(input.language ? { language: input.language } : {}),
    ...(input.instruct ? { instruct: input.instruct } : {}),
  }
  const t0 = Date.now()
  try {
    const r = await omniFetch('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: `audio/${fmt}` },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`/v1/audio/speech ${r.status} ${errText.slice(0, 200)}`)
    }
    const ab = await r.arrayBuffer()
    const audio = Buffer.from(ab)
    const mime = r.headers.get('content-type') ?? `audio/${fmt}`
    await recordHealth(workspaceId, true)
    // Record $0 cost in ai_usage for visibility (local = free).
    try {
      const { recordAiUsage } = await import('./ai-usage.js')
      await recordAiUsage({ workspaceId: workspaceId ?? 'default', source: 'voice.omnivoice', provider: 'omnivoice', model, inputTokens: input.text.length, outputTokens: 0, costUsd: 0 })
    } catch { /* tolerated — ai_usage path differs across builds */ }
    return { audio, mime, bytes: audio.length, format: fmt, voice: body.voice, durationMs: Date.now() - t0 }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── ASR ─────────────────────────────────────────────────────────────────────

export interface OmniAsrInput {
  audio:      Buffer
  filename?:  string
  language?:  string
  model?:     string  // 'whisper-1' or engine id (whisperx, faster-whisper, mlx-whisper, ...)
  prompt?:    string
}

export interface OmniAsrResult {
  text:       string
  durationMs: number
  language?:  string
  raw?:       unknown
}

export async function omniAsr(input: OmniAsrInput, workspaceId?: string): Promise<OmniAsrResult> {
  if (!input.audio || input.audio.length === 0) throw new Error('audio buffer required')
  // R610 — fall back to OpenAI Whisper when OmniVoice isn't available
  if (await shouldFallbackToOpenAi()) {
    const { openaiAsr } = await import('./r610-openai-voice-fallback.js')
    const asrInput: Parameters<typeof openaiAsr>[0] = { audio: input.audio }
    if (input.filename) asrInput.filename = input.filename
    if (input.language) asrInput.language = input.language
    if (input.prompt)   asrInput.prompt   = input.prompt
    const r = await openaiAsr(asrInput, workspaceId)
    const result: OmniAsrResult = { text: r.text, durationMs: r.durationMs, raw: { provider: r.provider } }
    if (r.language) result.language = r.language
    return result
  }
  const t0 = Date.now()
  const fd = new FormData()
  const blob = new Blob([input.audio as unknown as ArrayBuffer], { type: 'audio/wav' })
  fd.append('file', blob, input.filename ?? 'audio.wav')
  fd.append('model', input.model ?? 'whisper-1')
  if (input.language) fd.append('language', input.language)
  if (input.prompt)   fd.append('prompt', input.prompt)
  try {
    const r = await omniFetch('/v1/audio/transcriptions', { method: 'POST', body: fd as unknown as BodyInit })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`/v1/audio/transcriptions ${r.status} ${errText.slice(0, 200)}`)
    }
    const body = await r.json() as { text?: string; language?: string }
    await recordHealth(workspaceId, true)
    return { text: body.text ?? '', language: body.language, durationMs: Date.now() - t0, raw: body }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── Voice clone (profile creation) ─────────────────────────────────────────

export interface OmniCloneInput {
  name:        string
  audio:       Buffer
  filename?:   string
  refText?:    string
  language?:   string
}

export interface OmniCloneResult {
  profileId:  string
  name:       string
  durationMs: number
}

export async function omniCloneVoice(input: OmniCloneInput, workspaceId?: string): Promise<OmniCloneResult> {
  if (!input.name) throw new Error('name required')
  if (!input.audio || input.audio.length === 0) throw new Error('audio buffer required')
  // R610 — clone has no OpenAI equivalent
  if (await shouldFallbackToOpenAi()) {
    throw new Error('voice clone requires a running OmniVoice Studio server (3-sec sample → custom voice). OpenAI does not offer voice cloning. Use the 6 OpenAI presets via voice.omni.tts in the meantime, or run OmniVoice locally and set OMNIVOICE_BASE_URL.')
  }
  const t0 = Date.now()
  const fd = new FormData()
  fd.append('name', input.name)
  const blob = new Blob([input.audio as unknown as ArrayBuffer], { type: 'audio/wav' })
  fd.append('ref_audio', blob, input.filename ?? 'ref.wav')
  if (input.refText)  fd.append('ref_text', input.refText)
  if (input.language) fd.append('language', input.language)
  try {
    const r = await omniFetch('/profiles', { method: 'POST', body: fd as unknown as BodyInit })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`/profiles ${r.status} ${errText.slice(0, 200)}`)
    }
    const body = await r.json() as { id?: string; profile_id?: string; name?: string }
    const profileId = body.id ?? body.profile_id ?? ''
    if (!profileId) throw new Error('profile id missing in response')
    await recordHealth(workspaceId, true)
    return { profileId, name: body.name ?? input.name, durationMs: Date.now() - t0 }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

// ─── Video dubbing ───────────────────────────────────────────────────────────

export interface OmniDubStartInput {
  url:              string
  targetLanguages?: string[]
  voice?:           string
  preserveBackground?: boolean
}

export interface OmniDubJob {
  jobId:  string
  state:  string
  url?:   string
}

export async function omniDubStart(input: OmniDubStartInput, workspaceId?: string): Promise<OmniDubJob> {
  if (!input.url) throw new Error('url required')
  if (await shouldFallbackToOpenAi()) {
    throw new Error('video dubbing requires OmniVoice Studio (transcribe → translate → re-voice → mux MP4). No OpenAI equivalent. Run OmniVoice locally and set OMNIVOICE_BASE_URL.')
  }
  try {
    const r = await omniFetch('/dub/ingest-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: input.url,
        target_languages: input.targetLanguages ?? ['en'],
        ...(input.voice ? { voice: input.voice } : {}),
        ...(typeof input.preserveBackground === 'boolean' ? { preserve_background: input.preserveBackground } : {}),
      }),
      timeoutMs: 30_000,
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`/dub/ingest-url ${r.status} ${errText.slice(0, 200)}`)
    }
    const body = await r.json() as { job_id?: string; id?: string; state?: string; status?: string }
    const jobId = body.job_id ?? body.id ?? ''
    if (!jobId) throw new Error('job id missing in response')
    await recordHealth(workspaceId, true)
    return { jobId, state: body.state ?? body.status ?? 'queued' }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}

export async function omniDubStatus(jobId: string, workspaceId?: string): Promise<OmniDubJob> {
  if (!jobId) throw new Error('jobId required')
  try {
    const r = await omniFetch(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', timeoutMs: 10_000 })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`/jobs ${r.status} ${errText.slice(0, 200)}`)
    }
    const body = await r.json() as { state?: string; status?: string; download_url?: string; url?: string }
    await recordHealth(workspaceId, true)
    return { jobId, state: body.state ?? body.status ?? 'unknown', url: body.download_url ?? body.url }
  } catch (e) {
    await recordHealth(workspaceId, false, (e as Error).message)
    throw e
  }
}
