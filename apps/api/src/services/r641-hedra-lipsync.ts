/**
 * R641d — Avatar lipsync via Hedra (B7).
 *
 * Hedra has a hosted API for photo + audio → talking-head video. Free tier
 * gives a small monthly minute budget. We wrap it as:
 *
 *   avatar.lipsync — start a generation, returns generation_id
 *   avatar.status  — poll a generation
 *
 * Env:
 *   HEDRA_API_KEY  — required; obtain at https://www.hedra.com (free tier OK)
 *   HEDRA_BASE_URL — defaults to https://api.hedra.com
 *
 * Falls back to clean { ok: false, error } if HEDRA_API_KEY unset, matching
 * the R609/R610 pattern so callers can gate on it.
 */
import { Buffer } from 'node:buffer'

const HEDRA_DEFAULT_BASE = 'https://api.hedra.com'

interface HedraConfig { baseUrl: string; apiKey: string }

function cfg(): HedraConfig | null {
  const apiKey = process.env['HEDRA_API_KEY']
  if (!apiKey) return null
  return { baseUrl: process.env['HEDRA_BASE_URL'] ?? HEDRA_DEFAULT_BASE, apiKey }
}

export interface LipsyncInput {
  imageBase64?: string
  imageUrl?:    string
  audioBase64?: string
  audioUrl?:    string
  text?:        string         // when provided, server-side TTS via R610 first
  voice?:       string         // R610/R599 voice id when text given
  aspectRatio?: '1:1' | '9:16' | '16:9'
  duration?:    number         // seconds, capped at 30
}

export interface LipsyncStartResult {
  ok:             boolean
  provider?:      'hedra'
  generationId?:  string
  durationMs:     number
  error?:         string
}

async function asBuffer(input: { base64?: string; url?: string }): Promise<{ ok: true; buf: Buffer; mime: string } | { ok: false; error: string }> {
  if (input.base64) {
    const stripped = input.base64.replace(/^data:[^;]+;base64,/, '')
    return { ok: true, buf: Buffer.from(stripped, 'base64'), mime: 'application/octet-stream' }
  }
  if (input.url) {
    try {
      const r = await fetch(input.url, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 200) return { ok: false, error: 'fetched empty body' }
      return { ok: true, buf, mime: r.headers.get('content-type') ?? 'application/octet-stream' }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'base64 or url required' }
}

export async function startLipsync(input: LipsyncInput, workspaceId?: string): Promise<LipsyncStartResult> {
  const t0 = Date.now()
  const c = cfg()
  if (!c) return { ok: false, durationMs: 0, error: 'HEDRA_API_KEY not set' }

  // 1) Resolve image
  const img = await asBuffer({
    ...(input.imageBase64 ? { base64: input.imageBase64 } : {}),
    ...(input.imageUrl    ? { url:    input.imageUrl    } : {}),
  })
  if (!img.ok) return { ok: false, durationMs: Date.now() - t0, error: `image: ${img.error}` }

  // 2) Resolve audio — either provided directly OR synthesize via R610 from text
  let audioBuf: Buffer
  let audioMime = 'audio/mpeg'
  if (input.audioBase64 || input.audioUrl) {
    const aud = await asBuffer({
      ...(input.audioBase64 ? { base64: input.audioBase64 } : {}),
      ...(input.audioUrl    ? { url:    input.audioUrl    } : {}),
    })
    if (!aud.ok) return { ok: false, durationMs: Date.now() - t0, error: `audio: ${aud.error}` }
    audioBuf = aud.buf
    audioMime = aud.mime
  } else if (input.text) {
    try {
      const { omniTts } = await import('./r599-omnivoice-provider.js')
      const ttsInput: Parameters<typeof omniTts>[0] = { text: input.text.slice(0, 2000), format: 'mp3' }
      if (input.voice) ttsInput.voice = input.voice
      const r = await omniTts(ttsInput, workspaceId) as unknown as { audioBase64?: string; audio_base64?: string }
      const b64 = r.audioBase64 ?? r.audio_base64
      if (!b64) return { ok: false, durationMs: Date.now() - t0, error: 'tts produced no audio' }
      audioBuf = Buffer.from(b64, 'base64')
    } catch (e) { return { ok: false, durationMs: Date.now() - t0, error: `tts: ${(e as Error).message}` } }
  } else {
    return { ok: false, durationMs: Date.now() - t0, error: 'audioBase64, audioUrl, or text required' }
  }

  // 3) POST to Hedra. Hedra's API expects multipart upload of image + audio.
  try {
    const fd = new FormData()
    fd.set('image',  new Blob([new Uint8Array(img.buf)],   { type: img.mime || 'image/png' }), 'avatar.png')
    fd.set('audio',  new Blob([new Uint8Array(audioBuf)],  { type: audioMime }),              'voice.mp3')
    if (input.aspectRatio) fd.set('aspect_ratio', input.aspectRatio)
    if (typeof input.duration === 'number') fd.set('duration', String(Math.max(1, Math.min(30, input.duration))))

    const r = await fetch(`${c.baseUrl}/v1/generations`, {
      method: 'POST',
      headers: { 'X-API-Key': c.apiKey, accept: 'application/json' },
      body: fd,
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, durationMs: Date.now() - t0, error: `hedra ${r.status} ${text.slice(0, 200)}` }
    }
    const j = await r.json().catch(() => ({})) as { generation_id?: string; id?: string }
    const generationId = j.generation_id ?? j.id
    if (!generationId) return { ok: false, durationMs: Date.now() - t0, error: 'hedra: no generation_id' }
    return { ok: true, provider: 'hedra', generationId, durationMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, durationMs: Date.now() - t0, error: (e as Error).message }
  }
}

export interface LipsyncStatusResult {
  ok:          boolean
  status?:     'queued' | 'processing' | 'complete' | 'failed' | 'unknown'
  videoUrl?:   string
  progress?:   number
  error?:      string
}

export async function statusLipsync(input: { generationId: string }): Promise<LipsyncStatusResult> {
  const c = cfg()
  if (!c) return { ok: false, error: 'HEDRA_API_KEY not set' }
  if (!input.generationId) return { ok: false, error: 'generationId required' }
  try {
    const r = await fetch(`${c.baseUrl}/v1/generations/${encodeURIComponent(input.generationId)}`, {
      headers: { 'X-API-Key': c.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      return { ok: false, error: `hedra ${r.status} ${text.slice(0, 200)}` }
    }
    const j = await r.json().catch(() => ({})) as Record<string, unknown>
    const status = String(j['status'] ?? 'unknown').toLowerCase()
    const mapped: LipsyncStatusResult['status'] =
      status === 'complete' || status === 'completed' || status === 'succeeded' ? 'complete' :
      status === 'failed'   || status === 'error'                                ? 'failed'  :
      status === 'processing' || status === 'running'                            ? 'processing' :
      status === 'queued' || status === 'pending'                                ? 'queued' : 'unknown'
    const result: LipsyncStatusResult = { ok: true, status: mapped }
    if (j['video_url'])  result.videoUrl = String(j['video_url'])
    if (j['url'])        result.videoUrl = result.videoUrl ?? String(j['url'])
    if (typeof j['progress'] === 'number') result.progress = j['progress'] as number
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function lipsyncHealth(): { configured: boolean; baseUrl: string } {
  const c = cfg()
  return { configured: !!c, baseUrl: c?.baseUrl ?? HEDRA_DEFAULT_BASE }
}
