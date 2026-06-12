/**
 * R677 — OpenAI Whisper speech-to-text.
 *
 * Closes the audio loop opened by R668 TTS — operators can now speak/upload
 * audio and get text back. Source: assetId (audio asset), audioUrl, or
 * audioB64. Output: text transcript + optional segment timestamps.
 *
 * Pricing: $0.006/min (whisper-1) or $0.003/min (gpt-4o-mini-transcribe).
 * Default = mini-transcribe (cheaper) per R670 tier-down policy.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export interface WhisperInput {
  audioUrl?:  string
  audioB64?:  string
  assetId?:   string
  model?:     'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe'
  language?:  string  // ISO-639-1 (en, es, etc.) — boosts accuracy when known
  prompt?:    string  // guidance to bias decoding (proper nouns, acronyms)
  format?:    'json' | 'text' | 'srt' | 'verbose_json' | 'vtt'
}

export interface WhisperResult {
  ok:        boolean
  text?:     string
  segments?: Array<{ start: number; end: number; text: string }>
  language?: string
  durationSec?: number
  model:     string
  costUsd:   number
  latencyMs: number
  error?:    string
}

async function resolveAudioBytes(workspaceId: string, input: WhisperInput): Promise<{ bytes: Buffer; mime: string } | null> {
  if (input.audioB64) return { bytes: Buffer.from(input.audioB64, 'base64'), mime: 'audio/mpeg' }
  if (input.audioUrl) {
    try {
      const r = await fetch(input.audioUrl)
      if (!r.ok) return null
      const mime = r.headers.get('content-type') ?? 'audio/mpeg'
      return { bytes: Buffer.from(await r.arrayBuffer()), mime }
    } catch { return null }
  }
  if (input.assetId) {
    try {
      const rows = await db.execute(sql`
        SELECT public_url, mime FROM generated_assets
        WHERE id = ${input.assetId} AND workspace_id = ${workspaceId} LIMIT 1
      `)
      const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
      const url = r?.['public_url'] ? String(r['public_url']) : null
      const mime = r?.['mime'] ? String(r['mime']) : 'audio/mpeg'
      if (!url) return null
      const ir = await fetch(url)
      if (!ir.ok) return null
      return { bytes: Buffer.from(await ir.arrayBuffer()), mime }
    } catch { return null }
  }
  return null
}

function extFor(mime: string): string {
  if (mime.includes('mpeg') || mime.includes('mp3'))    return 'mp3'
  if (mime.includes('ogg')  || mime.includes('opus'))   return 'ogg'
  if (mime.includes('wav'))                              return 'wav'
  if (mime.includes('flac'))                             return 'flac'
  if (mime.includes('m4a')  || mime.includes('aac'))    return 'm4a'
  return 'mp3'
}

export async function transcribe(workspaceId: string, input: WhisperInput): Promise<WhisperResult> {
  const t0 = Date.now()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set', model: 'gpt-4o-mini-transcribe', costUsd: 0, latencyMs: Date.now() - t0 }

  const src = await resolveAudioBytes(workspaceId, input)
  if (!src) return { ok: false, error: 'failed to resolve audio (audioUrl/audioB64/assetId)', model: 'gpt-4o-mini-transcribe', costUsd: 0, latencyMs: Date.now() - t0 }

  const model = input.model ?? 'gpt-4o-mini-transcribe'
  const format = input.format ?? (model === 'gpt-4o-mini-transcribe' || model === 'gpt-4o-transcribe' ? 'json' : 'verbose_json')

  const fd = new FormData()
  fd.append('model', model)
  fd.append('file', new Blob([new Uint8Array(src.bytes)], { type: src.mime }), `audio.${extFor(src.mime)}`)
  fd.append('response_format', format)
  if (input.language) fd.append('language', input.language)
  if (input.prompt)   fd.append('prompt', input.prompt.slice(0, 1024))

  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: fd,
    })
    if (!res.ok) {
      return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
        model, costUsd: 0, latencyMs: Date.now() - t0 }
    }

    let text = ''
    let segments: Array<{ start: number; end: number; text: string }> | undefined
    let language: string | undefined
    let durationSec: number | undefined

    if (format === 'json' || format === 'verbose_json') {
      const j = await res.json() as { text?: string; language?: string; duration?: number; segments?: Array<{ start: number; end: number; text: string }> }
      text = j.text ?? ''
      if (j.language) language = j.language
      if (typeof j.duration === 'number') durationSec = j.duration
      if (j.segments) segments = j.segments.map(s => ({ start: s.start, end: s.end, text: s.text }))
    } else {
      text = await res.text()
    }

    const ratePerMin = model === 'whisper-1' ? 0.006 : 0.003
    const costUsd = durationSec ? (durationSec / 60) * ratePerMin : 0
    const result: WhisperResult = {
      ok: true, text, model,
      costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - t0,
    }
    if (segments)    result.segments    = segments
    if (language)    result.language    = language
    if (durationSec) result.durationSec = durationSec
    return result
  } catch (e) {
    return { ok: false, error: (e as Error).message, model, costUsd: 0, latencyMs: Date.now() - t0 }
  }
}
