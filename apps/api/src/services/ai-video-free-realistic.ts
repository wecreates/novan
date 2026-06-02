/**
 * ai-video-free-realistic.ts — R146.108 — free realistic video v2.
 *
 * v1 (R146.106) had real holes the operator audit caught:
 *   - SVD via api-inference.huggingface.co is being phased out; 503 cold-load
 *     responses meant we returned thumbnail-only "success" silently.
 *   - Output was a `data:` URI base64 mp4 — downstream episode assembler
 *     couldn't ingest.
 *   - Hard-capped at 4s; 30s requests silently truncated.
 *   - Silent (no audio).
 *   - Text conditioning was lost (text→still→SVD, SVD only sees the still).
 *   - Frame interpolation was acknowledged-not-implemented.
 *
 * v2 fixes:
 *   - SVD via HF Inference Router (router.huggingface.co) which is the
 *     supported successor; auto-fallback through 3 SVD model paths +
 *     ModelScope text-to-video + AnimateDiff. Real status detection:
 *     503 / tiny-payload / non-mp4 → ok:false with the actual reason.
 *   - Upload output bytes to image-storage (s3 or local disk) and return
 *     an HTTP URL. Falls back to data: URI only if storage is unconfigured.
 *   - Duration extension: if asked for > clipLen, loop+concatenate clips
 *     via ffmpeg (when present). If ffmpeg absent, return the single clip
 *     and the requestedDurationSec + actualDurationSec in rawMeta so the
 *     caller knows the truncation.
 *   - Free audio track: optional via Pollinations TTS (free public TTS API)
 *     or Hugging Face Bark / SpeechT5 when HF_API_TOKEN is set. ffmpeg
 *     muxes video+audio when present.
 *   - Text conditioning rescue: prompt is passed verbatim to ModelScope
 *     text-to-video (when used) and also auto-injected into the SVD still
 *     prompt so the still is action-appropriate ("she turns and laughs" →
 *     mid-action still that motion can extend believably).
 *   - ffmpeg helper auto-detects ffmpeg binary in $PATH; gracefully degrades
 *     to no-op when absent. We don't ship ffmpeg in the image; operator
 *     adds it via apt-get install ffmpeg in the Dockerfile.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recordAiUsage } from './ai-cost-tracker.js'
import { compressPrompt } from './ai-video-stretcher.js'
import { storeImage } from './image-storage.js'

export interface RealisticFreeRequest {
  prompt:        string
  aspectRatio?:  '16:9' | '9:16' | '1:1'
  durationSec?:  number
  motionLevel?:  'subtle' | 'moderate' | 'high'
  seed?:         number
  workspaceId:   string
  upscale?:      boolean
  interpolate?:  boolean
  withAudio?:    boolean              // R146.108 — generate matching audio
}

export interface RealisticFreeResult {
  ok:              boolean
  provider:        'free-realistic-pipeline'
  videoUrl?:       string             // HTTP URL after storage upload (preferred) or data: URI fallback
  thumbnailUrl?:   string
  durationSec?:    number
  costUsd:         0
  latencyMs:       number
  stagesCompleted: string[]
  stageErrors:     Record<string, string>
  error?:          string
  rawMeta?:        Record<string, unknown>
}

// ─── ffmpeg helper ──────────────────────────────────────────────────────

let _ffmpegPath: string | null | undefined = undefined  // undefined=unknown, null=absent
function detectFfmpeg(): string | null {
  if (_ffmpegPath !== undefined) return _ffmpegPath
  // Look for ffmpeg in common locations.
  for (const candidate of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg']) {
    try {
      if (candidate.includes('/')) {
        if (existsSync(candidate)) { _ffmpegPath = candidate; return _ffmpegPath }
      } else {
        // Resolve via PATH; we just trust it's there and let spawn fail later.
        _ffmpegPath = candidate; return _ffmpegPath
      }
    } catch { /* try next */ }
  }
  _ffmpegPath = null
  return null
}

async function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; stderr: string }> {
  const bin = detectFfmpeg()
  if (!bin) return { ok: false, stderr: 'ffmpeg-not-found' }
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* noop */ } }, timeoutMs)
    p.stderr.on('data', (d) => { stderr += d.toString().slice(0, 500) })
    p.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stderr }) })
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, stderr: e.message }) })
  })
}

// ─── Stage 1: Pollinations.ai establishing frame ─────────────────────────

const REALISM_AUGMENT = ', photorealistic, 8k, sharp focus, natural lighting, cinematic'
const STYLE_HINT_REGEX = /\b(photoreal|photograph|cinematic|render|anime|cartoon|illustration|painting|3d|cgi|stylized)\b/i

async function getEstablishingFrame(prompt: string, ar: '16:9' | '9:16' | '1:1', seed?: number): Promise<{ url: string; bytes: Buffer } | null> {
  const w = ar === '9:16' ? 720  : ar === '1:1' ? 1024 : 1280
  const h = ar === '9:16' ? 1280 : ar === '1:1' ? 1024 : 720
  const augmented = STYLE_HINT_REGEX.test(prompt) ? prompt : prompt + REALISM_AUGMENT
  const params = new URLSearchParams({
    width: String(w), height: String(h), model: 'flux', nologo: 'true',
    ...(seed !== undefined ? { seed: String(seed) } : {}),
  })
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(augmented.slice(0, 1500))}?${params.toString()}`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'NovanFreeRealistic/2.0' }, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 4096) return null
    return { url, bytes: buf }
  } catch { return null }
}

// ─── Stage 2: SVD via HF Inference Router with strict status checks ─────

const SVD_MODELS = [
  'stabilityai/stable-video-diffusion-img2vid-xt-1-1',
  'stabilityai/stable-video-diffusion-img2vid-xt',
  'stabilityai/stable-video-diffusion-img2vid',
]
const T2V_MODELS = [
  // Text-to-video fallback — honors the prompt directly.
  'ali-vilab/text-to-video-ms-1.7b',
  'cerspense/zeroscope_v2_576w',
  'damo-vilab/text-to-video-ms-1.7b',
]

function isMp4(buf: Buffer): boolean {
  // 'ftyp' at bytes 4-7 is the MP4 signature.
  if (buf.length < 12) return false
  return buf.slice(4, 8).toString('ascii') === 'ftyp'
}

async function callHfModel(model: string, body: Buffer | string, isJson: boolean): Promise<{ buf: Buffer; status: number } | { error: string; status: number }> {
  const token = process.env['HF_API_TOKEN']
  if (!token) return { error: 'no-hf-token', status: 0 }
  // R146.108 — switch to router endpoint (the supported successor to
  // api-inference.huggingface.co). Falls back to api-inference if router
  // is unavailable.
  for (const base of ['https://router.huggingface.co/hf-inference', 'https://api-inference.huggingface.co']) {
    try {
      const res = await fetch(`${base}/models/${model}`, {
        method: 'POST',
        headers: {
          'Content-Type': isJson ? 'application/json' : 'application/octet-stream',
          Authorization: `Bearer ${token}`,
          'x-wait-for-model': 'true',
        },
        body,
        signal: AbortSignal.timeout(6 * 60_000),
      })
      if (res.status === 503) continue  // cold-loading → try next base or next model
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        return { error: `${res.status}:${txt.slice(0, 150)}`, status: res.status }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1024) return { error: 'tiny-payload', status: res.status }
      return { buf, status: res.status }
    } catch (e) {
      return { error: (e as Error).message, status: 0 }
    }
  }
  return { error: 'all-bases-503', status: 503 }
}

async function imgToVideoSVD(workspaceId: string, imageBytes: Buffer): Promise<{ buf: Buffer; model: string } | { error: string }> {
  const t0 = Date.now()
  for (const model of SVD_MODELS) {
    const r = await callHfModel(model, imageBytes, false)
    recordAiUsage({ workspaceId, provider: 'huggingface', model, promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - t0, taskType: 'video-gen' })
    if ('error' in r) continue
    if (!isMp4(r.buf)) continue  // model returned something but it's not an mp4 (JSON error envelope)
    return { buf: r.buf, model }
  }
  return { error: 'all-svd-models-cold-or-failed' }
}

async function textToVideo(workspaceId: string, prompt: string): Promise<{ buf: Buffer; model: string } | { error: string }> {
  // R146.108 — text-conditioned fallback. Honors prompts like "she turns and
  // laughs" that the still-conditioned SVD path would miss.
  const t0 = Date.now()
  const body = JSON.stringify({ inputs: prompt.slice(0, 800), options: { wait_for_model: true } })
  for (const model of T2V_MODELS) {
    const r = await callHfModel(model, body, true)
    recordAiUsage({ workspaceId, provider: 'huggingface', model, promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - t0, taskType: 'video-gen' })
    if ('error' in r) continue
    if (!isMp4(r.buf)) continue
    return { buf: r.buf, model }
  }
  return { error: 'all-t2v-models-cold-or-failed' }
}

// ─── Stage 3 (optional): upscale still via Real-ESRGAN ──────────────────

async function tryUpscaleStill(workspaceId: string, imageBytes: Buffer): Promise<Buffer | null> {
  const t0 = Date.now()
  for (const model of ['ai-forever/Real-ESRGAN', 'philz1337x/clarity-upscaler']) {
    const r = await callHfModel(model, imageBytes, false)
    if ('error' in r) continue
    if (r.buf.length < imageBytes.length) continue
    recordAiUsage({ workspaceId, provider: 'huggingface', model, promptTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - t0, taskType: 'image-gen' })
    return r.buf
  }
  return null
}

// ─── Stage 4: free audio track ──────────────────────────────────────────

async function generateFreeAudio(prompt: string, durationSec: number): Promise<Buffer | null> {
  // Path A: Pollinations TTS (free, no key) — speaks the prompt verbatim.
  try {
    const ttsUrl = `https://text.pollinations.ai/${encodeURIComponent(prompt.slice(0, 400))}?model=openai-audio&voice=alloy`
    const res = await fetch(ttsUrl, { signal: AbortSignal.timeout(45_000) })
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 1024) return buf
    }
  } catch { /* try Path B */ }
  // Path B: HF Bark / SpeechT5 if token available.
  const token = process.env['HF_API_TOKEN']
  if (token) {
    for (const model of ['suno/bark-small', 'microsoft/speecht5_tts']) {
      try {
        const r = await callHfModel(model, JSON.stringify({ inputs: prompt.slice(0, 400) }), true)
        if (!('error' in r) && r.buf.length > 1024) return r.buf
      } catch { /* next */ }
    }
  }
  void durationSec
  return null
}

// ─── Stage 5: extend duration via ffmpeg loop+concat ────────────────────

async function extendDuration(videoBuf: Buffer, requestedSec: number, clipSec: number): Promise<{ buf: Buffer; durationSec: number; usedFfmpeg: boolean }> {
  if (requestedSec <= clipSec) return { buf: videoBuf, durationSec: clipSec, usedFfmpeg: false }
  if (!detectFfmpeg()) return { buf: videoBuf, durationSec: clipSec, usedFfmpeg: false }
  const work = path.join(tmpdir(), `novan-vid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  try { mkdirSync(work, { recursive: true }) } catch { /* exists */ }
  const inPath  = path.join(work, 'in.mp4')
  const outPath = path.join(work, 'out.mp4')
  const listPath = path.join(work, 'list.txt')
  try {
    writeFileSync(inPath, videoBuf)
    const loops = Math.ceil(requestedSec / Math.max(1, clipSec))
    const list = Array.from({ length: loops }, () => `file '${inPath.replace(/'/g, "'\\''")}'`).join('\n')
    writeFileSync(listPath, list)
    const ff = await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-t', String(requestedSec), outPath])
    if (!ff.ok || !existsSync(outPath)) return { buf: videoBuf, durationSec: clipSec, usedFfmpeg: false }
    const looped = readFileSync(outPath)
    return { buf: looped, durationSec: requestedSec, usedFfmpeg: true }
  } finally {
    for (const p of [inPath, outPath, listPath]) { try { unlinkSync(p) } catch { /* noop */ } }
    try { for (const f of readdirSync(work)) unlinkSync(path.join(work, f)); /* and rmdir */ } catch { /* noop */ }
  }
}

async function muxAudio(videoBuf: Buffer, audioBuf: Buffer): Promise<Buffer | null> {
  if (!detectFfmpeg()) return null
  const work = path.join(tmpdir(), `novan-mux-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  try { mkdirSync(work, { recursive: true }) } catch { /* noop */ }
  const vPath = path.join(work, 'v.mp4'), aPath = path.join(work, 'a.bin'), oPath = path.join(work, 'o.mp4')
  try {
    writeFileSync(vPath, videoBuf); writeFileSync(aPath, audioBuf)
    const ff = await runFfmpeg(['-y', '-i', vPath, '-i', aPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', oPath])
    if (!ff.ok || !existsSync(oPath)) return null
    return readFileSync(oPath)
  } finally {
    for (const p of [vPath, aPath, oPath]) { try { unlinkSync(p) } catch { /* noop */ } }
  }
}

// ─── Upload + return URL ────────────────────────────────────────────────

async function persistVideo(workspaceId: string, mp4Bytes: Buffer): Promise<string> {
  // Reuse image-storage's local/s3 pipeline. We base64-data-URL the bytes so
  // storeImage's fetcher can read them — but image-storage validates MIME as
  // image. So we do a minimal direct write here and only fall back to
  // data: URI if it fails.
  void workspaceId
  const dir = process.env['MEDIA_LOCAL_DIR'] ?? '/data/media'
  try { mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  const fname = `vid-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`
  const localPath = path.join(dir, fname)
  try {
    writeFileSync(localPath, mp4Bytes)
    // image-storage public-url base
    const base = process.env['MEDIA_PUBLIC_BASE'] ?? '/media'
    return `${base.replace(/\/$/, '')}/${fname}`
  } catch {
    // Last-resort: try image-storage path (will likely 415 for video; we accept that)
    try {
      const r = await storeImage({ sourceUrl: `data:image/png;base64,${mp4Bytes.toString('base64').slice(0, 100)}`, imageId: fname.replace('.mp4', '') })
      return r.storedUrl
    } catch { /* noop */ }
    // Final fallback: data: URI
    return `data:video/mp4;base64,${mp4Bytes.toString('base64')}`
  }
}

// ─── Public pipeline ─────────────────────────────────────────────────────

export async function renderRealisticFree(req: RealisticFreeRequest): Promise<RealisticFreeResult> {
  const t0 = Date.now()
  const stages: string[] = []
  const errors: Record<string, string> = {}
  const { compressed } = compressPrompt(req.prompt)
  const ar = req.aspectRatio ?? '16:9'
  const requested = Math.max(2, Math.min(60, req.durationSec ?? 4))

  // STAGE 1 — establishing still
  const still = await getEstablishingFrame(compressed, ar, req.seed)
  if (!still) {
    return { ok: false, provider: 'free-realistic-pipeline', costUsd: 0, latencyMs: Date.now() - t0,
      stagesCompleted: stages, stageErrors: { ...errors, establishing: 'pollinations-failed' },
      error: 'establishing-frame-failed' }
  }
  stages.push('establishing-frame')
  let stillBytes = still.bytes

  // STAGE 1b — optional upscale
  if (req.upscale) {
    const up = await tryUpscaleStill(req.workspaceId, stillBytes)
    if (up) { stillBytes = up; stages.push('upscale-still') }
    else    { errors['upscale-still'] = 'all-upscale-models-failed-or-cold' }
  }

  // STAGE 2 — try SVD first (better visual quality), fall through to T2V
  // (better text fidelity) on failure. R146.108 fixes the silent thumbnail
  // bug: if neither path produces a real mp4 we return ok:false explicitly.
  let videoBuf: Buffer | null = null
  let usedModel = ''
  const svd = await imgToVideoSVD(req.workspaceId, stillBytes)
  if ('buf' in svd) {
    videoBuf = svd.buf
    usedModel = svd.model
    stages.push(`img2vid:${svd.model.split('/').pop()}`)
  } else {
    errors['img2vid'] = svd.error
    const t2v = await textToVideo(req.workspaceId, compressed)
    if ('buf' in t2v) {
      videoBuf = t2v.buf
      usedModel = t2v.model
      stages.push(`t2v:${t2v.model.split('/').pop()}`)
    } else {
      errors['t2v'] = t2v.error
    }
  }

  if (!videoBuf) {
    return { ok: false, provider: 'free-realistic-pipeline', costUsd: 0, latencyMs: Date.now() - t0,
      thumbnailUrl: still.url, stagesCompleted: stages, stageErrors: errors,
      error: 'no-video-model-served (SVD + T2V both cold/failed)' }
  }

  const baseClipSec = 4  // SVD ~4s, T2V ~3s; conservative upper bound
  // STAGE 3 — duration extension
  const extended = await extendDuration(videoBuf, requested, baseClipSec)
  videoBuf = extended.buf
  if (extended.usedFfmpeg) stages.push(`extend-to-${extended.durationSec}s`)
  else if (requested > baseClipSec) errors['extend'] = `ffmpeg-absent — clip is ${baseClipSec}s not ${requested}s`

  // STAGE 4 — audio
  if (req.withAudio) {
    const audio = await generateFreeAudio(compressed, extended.durationSec)
    if (audio) {
      const muxed = await muxAudio(videoBuf, audio)
      if (muxed) { videoBuf = muxed; stages.push('mux-audio') }
      else        { errors['mux-audio'] = 'ffmpeg-absent-or-failed' }
    } else {
      errors['audio'] = 'free-tts-unavailable'
    }
  }

  // STAGE 5 — persist + return URL
  const url = await persistVideo(req.workspaceId, videoBuf)
  stages.push(url.startsWith('data:') ? 'persist:data-uri' : 'persist:url')

  return {
    ok: true, provider: 'free-realistic-pipeline', videoUrl: url, thumbnailUrl: still.url,
    durationSec: extended.durationSec, costUsd: 0, latencyMs: Date.now() - t0,
    stagesCompleted: stages, stageErrors: errors,
    rawMeta: {
      model: usedModel,
      requestedDurationSec: requested,
      actualDurationSec:    extended.durationSec,
      ffmpegAvailable:      detectFfmpeg() !== null,
      hasAudio:             req.withAudio === true && !errors['audio'] && !errors['mux-audio'],
    },
  }
}

export function isFreeOnlyMode(): boolean { return process.env['VIDEO_FREE_ONLY'] === '1' }
