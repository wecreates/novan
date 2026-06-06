/**
 * music-multimodal.ts — turn images, videos, and sound clips into songs.
 *
 * Three entry points:
 *
 *   fromImage(input)  — vision LLM extracts mood, palette, genre cues,
 *                       instrumentation, tempo range, vocal type from
 *                       the image, then renders a matching song via
 *                       ACE-Step master tier.
 *
 *   fromVideo(input)  — runs the full video-analyzer (frames + transcript
 *                       + on-screen text) then converts the synthesis to
 *                       a music caption. Optionally duration-matched.
 *
 *   fromAudio(input)  — Whisper transcribes any spoken/sung content,
 *                       ACE-Step extracts bpm/key, then generates a new
 *                       song in the same vibe (continuation or remix).
 *
 * Each accepts a local path or any URL (yt-dlp + Playwright reused for
 * downloads). Operator instructions augment the caption.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { MusicJob, GenerateMusicInput } from './music-studio.js'

// ─── Types ─────────────────────────────────────────────────────────────
export interface FromImageInput  { path?: string; url?: string; instructions?: string; duration?: number; workspaceId?: string }
export interface FromVideoInput  { url: string; instructions?: string; matchDuration?: boolean; workspaceId?: string }
export interface FromAudioInput  { path?: string; url?: string; instructions?: string; mode?: 'cover' | 'continue' | 'remix'; workspaceId?: string }

export interface MultimodalMusicResult extends MusicJob {
  caption?: string                  // the auto-generated music caption
  source?: { kind: 'image' | 'video' | 'audio'; ref: string; title?: string }
}

// ─── Image → music caption via vision LLM ──────────────────────────────
async function captionImageForMusic(imageBase64: string, mimeType: string, instructions: string): Promise<string> {
  const promptText =
`You are a music producer. Look at this image and produce a SINGLE concise music-generation caption (no preamble, no JSON) that describes the song the image evokes. Cover, in this order, comma-separated:
- genre / sub-genre
- mood + emotional arc
- tempo (e.g. "92 BPM")
- key suggestion (e.g. "key C minor")
- instrumentation (3-6 specific instruments)
- vocal type (e.g. "breathy female vocal", "no vocals", "male tenor with vibrato")
- production style (e.g. "warm analog tape", "crisp modern digital", "lo-fi bedroom")
- color/atmospheric cue from the image (e.g. "neon magenta sunset" → "synthwave shimmer")

${instructions ? `Operator wants: ${instructions}` : ''}

Output ONLY the caption sentence. No quotes, no JSON, no list, no explanation.`

  // Try Gemini 2.5 Pro → GPT-4o → Claude Opus
  const geminiKey = process.env['GEMINI_API_KEY']
  if (geminiKey) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-pro'}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: promptText },
            { inlineData: { mimeType, data: imageBase64 } },
          ] }],
          generationConfig: { temperature: 0.5, maxOutputTokens: 400 },
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (r.ok) {
        const j = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        const t = (j.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()
        if (t.length > 10) return t
      }
    } catch { /* */ }
  }
  const openaiKey = process.env['OPENAI_API_KEY']
  if (openaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env['OPENAI_VISION_MODEL'] ?? 'gpt-4o',
          messages: [
            { role: 'system', content: 'Music producer who captions images as song prompts.' },
            { role: 'user', content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' } },
            ] },
          ],
          temperature: 0.5, max_tokens: 400,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (r.ok) {
        const j = await r.json() as { choices?: Array<{ message?: { content?: string } }> }
        const t = (j.choices?.[0]?.message?.content ?? '').trim()
        if (t.length > 10) return t
      }
    } catch { /* */ }
  }
  const anthropicKey = process.env['ANTHROPIC_API_KEY']
  if (anthropicKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env['ANTHROPIC_VISION_MODEL'] ?? 'claude-opus-4-5',
          max_tokens: 400, temperature: 0.5,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: promptText },
          ] }],
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (r.ok) {
        const j = await r.json() as { content?: Array<{ text?: string }> }
        const t = (j.content?.[0]?.text ?? '').trim()
        if (t.length > 10) return t
      }
    } catch { /* */ }
  }
  return ''
}

async function loadImageAsBase64(input: FromImageInput): Promise<{ data: string; mime: string; ref: string } | null> {
  if (input.path && existsSync(input.path)) {
    const buf = await readFile(input.path)
    const ext = extname(input.path).toLowerCase().replace('.', '')
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    return { data: buf.toString('base64'), mime, ref: input.path }
  }
  if (input.url) {
    // R146.313 — SSRF guard. input.url is operator/LLM-controlled and could
    // point at cloud IMDS or container-internal services. Block before fetch.
    const { ssrfReject } = await import('../util/ssrf-guard.js')
    const reject = ssrfReject(input.url)
    if (reject) return null
    try {
      const r = await fetch(input.url, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok) return null
      const mime = r.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
      const buf = Buffer.from(await r.arrayBuffer())
      return { data: buf.toString('base64'), mime, ref: input.url }
    } catch { return null }
  }
  return null
}

// ─── Public: image → song ──────────────────────────────────────────────
export async function fromImage(input: FromImageInput): Promise<MultimodalMusicResult> {
  const startedAt = Date.now()
  const img = await loadImageAsBase64(input)
  if (!img) return { ok: false, status: 'failed', error: 'image not loadable (path or url required)', startedAt }
  const caption = await captionImageForMusic(img.data, img.mime, input.instructions ?? '')
  if (!caption) return { ok: false, status: 'failed', error: 'vision LLM could not caption image', startedAt }
  const { generateMusic } = await import('./music-studio.js')
  const gen: GenerateMusicInput = { prompt: caption, quality: 'master' }
  if (input.duration)    gen.duration    = input.duration
  if (input.workspaceId) gen.workspaceId = input.workspaceId
  const job = await generateMusic(gen)
  return { ...job, caption, source: { kind: 'image', ref: img.ref }, startedAt, finishedAt: Date.now() }
}

// ─── Public: video → song ──────────────────────────────────────────────
export async function fromVideo(input: FromVideoInput): Promise<MultimodalMusicResult> {
  const startedAt = Date.now()
  const { analyzeVideo } = await import('./video-analyzer.js')
  const v = await analyzeVideo(input.url, input.instructions ?? '', input.workspaceId ?? 'default')
  if (!v.ok) return { ok: false, status: 'failed', error: `video analysis failed: ${v.error ?? 'unknown'}`, startedAt }

  const captionParts: string[] = []
  if (input.instructions) captionParts.push(input.instructions)
  if (v.summary)          captionParts.push(`Inspired by: ${v.summary.split('\n')[0]}`)
  if (v.title)            captionParts.push(`Tied to: "${v.title}"`)
  captionParts.push('cinematic score, dynamic arrangement, full mix with depth and breath')
  const caption = captionParts.join('. ')

  const { generateMusic } = await import('./music-studio.js')
  const gen: GenerateMusicInput = { prompt: caption, quality: 'master' }
  if (input.matchDuration && v.durationSec) gen.duration = Math.min(v.durationSec, 600)
  if (input.workspaceId) gen.workspaceId = input.workspaceId
  const job = await generateMusic(gen)
  const source: MultimodalMusicResult['source'] = { kind: 'video', ref: input.url }
  if (v.title) source.title = v.title
  return { ...job, caption, source, startedAt, finishedAt: Date.now() }
}

// ─── Public: audio → song ──────────────────────────────────────────────
export async function fromAudio(input: FromAudioInput): Promise<MultimodalMusicResult> {
  const startedAt = Date.now()

  // Resolve local path (download via yt-dlp if URL)
  let localPath: string | undefined
  let ref = ''
  if (input.path && existsSync(input.path)) {
    localPath = input.path
    ref = input.path
  } else if (input.url) {
    ref = input.url
    // Reuse music-studio's downloader for any URL form
    try {
      const { spawn } = await import('node:child_process')
      const { existsSync: ex, mkdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const dir = join(tmpdir(), 'novan-music')
      if (!ex(dir)) mkdirSync(dir, { recursive: true })
      const stamp = Date.now().toString(36)
      const outBase = join(dir, `mm-src-${stamp}`)
      const outAudio = `${outBase}.wav`
      const ytdlp = process.env['YTDLP_BIN'] ?? 'yt-dlp'
      const ff    = process.env['FFMPEG_BIN'] ?? 'ffmpeg'
      const ok = await new Promise<boolean>((resolve) => {
        let proc
        try { proc = spawn(ytdlp, ['-x', '--audio-format', 'wav', '--audio-quality', '0', '--no-playlist', '-o', `${outBase}.%(ext)s`, '--ffmpeg-location', ff, input.url!], { windowsHide: true }) }
        catch { resolve(false); return }
        proc.on('error', () => resolve(false))
        proc.on('close', (c) => resolve(c === 0 && ex(outAudio)))
      })
      if (ok) localPath = outAudio
    } catch { /* */ }
  }
  if (!localPath) return { ok: false, status: 'failed', error: 'audio not loadable', startedAt }

  // Transcribe + analyze in parallel
  const { generateMusic, isAceServerUp, autoStartServer } = await import('./music-studio.js')

  // Whisper for any lyrical content — multi-provider fallback (Groq → OpenAI)
  // Previously: only tried Groq; on Groq failure transcript was silently empty.
  // Inconsistent with caption-service + video-analyzer which both fall back.
  let transcript = ''
  try {
    const buf = await readFile(localPath)
    const groqKey = process.env['GROQ_API_KEY']
    if (groqKey) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'src.wav')
      form.append('model', process.env['GROQ_WHISPER_MODEL'] ?? 'whisper-large-v3')
      form.append('response_format', 'text')
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${groqKey}` }, body: form,
        signal: AbortSignal.timeout(180_000),
      })
      if (r.ok) transcript = (await r.text()).trim()
    }
    // Fallback to OpenAI Whisper if Groq failed or no key
    if (!transcript) {
      const openaiKey = process.env['OPENAI_API_KEY']
      if (openaiKey) {
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/wav' }), 'src.wav')
        form.append('model', 'whisper-1')
        form.append('response_format', 'text')
        const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST', headers: { Authorization: `Bearer ${openaiKey}` }, body: form,
          signal: AbortSignal.timeout(300_000),
        })
        if (r.ok) transcript = (await r.text()).trim()
      }
    }
  } catch { /* */ }

  // ACE-Step analysis for bpm/key (best-effort)
  if (!(await isAceServerUp())) await autoStartServer()
  let bpm: number | undefined, key: string | undefined
  try {
    const base = process.env['ACESTEP_API_URL'] ?? 'http://127.0.0.1:8001'
    const r = await fetch(`${base}/release_task`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ analysis_only: true, reference_audio_path: localPath }),
      signal: AbortSignal.timeout(30_000),
    })
    if (r.ok) {
      const j = await r.json() as { task_id?: string; job_id?: string }
      const id = j.task_id ?? j.job_id
      if (id) {
        const { pollJob } = await import('./music-studio.js')
        const a = await pollJob(id, 5 * 60_000)
        if (a.bpm) bpm = a.bpm
        if (a.key) key = a.key
      }
    }
  } catch { /* */ }

  const mode = input.mode ?? 'cover'
  const captionBits = [
    input.instructions ?? '',
    transcript ? `Lyrical theme inspired by: "${transcript.slice(0, 200).replace(/\s+/g, ' ')}"` : '',
    bpm ? `${bpm} BPM` : '',
    key ? `key ${key}` : '',
    mode === 'continue' ? 'natural musical continuation, same vibe and instrumentation' :
    mode === 'remix'    ? 'creative remix with same vibe, fresh arrangement, modern production' :
                          'in the same style and mood, full studio mix',
  ].filter(Boolean)
  const caption = captionBits.join(', ')

  const gen: GenerateMusicInput = {
    prompt: caption,
    quality: 'master',
    referenceAudioPath: localPath,
    coverStrength: mode === 'continue' ? 0.85 : mode === 'remix' ? 0.5 : 0.7,
    coverNoise:    mode === 'continue' ? 0.2  : mode === 'remix' ? 0.55 : 0.35,
  }
  if (bpm)  gen.bpm = bpm
  if (key)  gen.key = key
  if (input.workspaceId) gen.workspaceId = input.workspaceId
  const job = await generateMusic(gen)
  return { ...job, caption, source: { kind: 'audio', ref }, startedAt, finishedAt: Date.now() }
}

// ─── URL detection ─────────────────────────────────────────────────────
const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|tiff?|heic|heif)(?:\?|$)/i
const AUDIO_EXT_RE = /\.(?:mp3|wav|flac|m4a|ogg|opus|aac|aiff?)(?:\?|$)/i

export function isLikelyImageUrl(url: string): boolean { return IMAGE_EXT_RE.test(url) }
export function isLikelyAudioUrl(url: string): boolean { return AUDIO_EXT_RE.test(url) }

export function extractImageUrls(text: string): string[] {
  if (!text) return []
  const re = /\bhttps?:\/\/[^\s<>"']+/g
  return Array.from(new Set((text.match(re) ?? []).filter(isLikelyImageUrl))).slice(0, 2)
}
export function extractAudioUrls(text: string): string[] {
  if (!text) return []
  const re = /\bhttps?:\/\/[^\s<>"']+/g
  return Array.from(new Set((text.match(re) ?? []).filter(isLikelyAudioUrl))).slice(0, 2)
}
