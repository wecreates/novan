/**
 * R642b — Media tools backed by FFmpeg + poppler-utils.
 *
 *   video.burn_captions    burn an SRT/VTT/ASS subtitle file into a video (A6)
 *   audio.extract          pull audio track from a video (mp3 by default)
 *   pdf.text_native        pdftotext-based text extraction (faster than pdfjs)
 *
 * Stems separation (A5) deferred — Demucs needs PyTorch (~2 GB) and is
 * CPU-heavy on small VPS. Will arrive when a worker node is added.
 *
 * All processes use spawned children with timeouts; temp files are cleaned
 * up unconditionally via try/finally.
 */
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface RunResult { ok: boolean; stdout: string; stderr: string; code: number; durationMs: number }

async function run(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise<RunResult>((resolve) => {
    let stdout = '', stderr = '', settled = false
    const child = spawn(cmd, args, opts.cwd ? { cwd: opts.cwd } : {})
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolve({ ok: false, stdout, stderr: stderr + '\n[timeout]', code: -1, durationMs: Date.now() - t0 }) } }, opts.timeoutMs ?? 120_000)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e), code: -1, durationMs: Date.now() - t0 }) } })
    child.on('close', (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: (code ?? 0) === 0, stdout, stderr, code: code ?? 0, durationMs: Date.now() - t0 }) } })
  })
}

async function resolveBytes(input: { base64?: string; url?: string }): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
  if (input.base64) {
    const stripped = input.base64.replace(/^data:[^;]+;base64,/, '')
    return { ok: true, buf: Buffer.from(stripped, 'base64') }
  }
  if (input.url) {
    try {
      const r = await fetch(input.url, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) return { ok: false, error: `fetch ${r.status}` }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 100) return { ok: false, error: 'empty body' }
      return { ok: true, buf }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  }
  return { ok: false, error: 'base64 or url required' }
}

async function ffmpegHealthOnce(): Promise<{ ok: boolean; version: string }> {
  const r = await run('ffmpeg', ['-version'], { timeoutMs: 5_000 })
  if (!r.ok) return { ok: false, version: '' }
  const v = r.stdout.match(/ffmpeg version (\S+)/)?.[1] ?? ''
  return { ok: true, version: v }
}

let cachedFfmpegHealth: { ok: boolean; version: string } | null = null
export async function mediaToolsHealth(): Promise<{ ffmpeg: { ok: boolean; version: string }; pdftotext: { ok: boolean; version: string } }> {
  if (!cachedFfmpegHealth) cachedFfmpegHealth = await ffmpegHealthOnce()
  const p = await run('pdftotext', ['-v'], { timeoutMs: 5_000 })
  const pv = (p.stderr || p.stdout).match(/pdftotext version (\S+)/)?.[1] ?? ''
  return { ffmpeg: cachedFfmpegHealth, pdftotext: { ok: p.ok || pv.length > 0, version: pv } }
}

// ─── A6 Caption burn ────────────────────────────────────────────────────────

export interface BurnCaptionsInput {
  videoBase64?:  string
  videoUrl?:     string
  subtitlesText: string         // SRT/VTT/ASS content
  format?:       'srt' | 'vtt' | 'ass'    // default 'srt'
  fontSize?:     number         // default 24
  fontColor?:    string         // default 'white'
  outlineColor?: string         // default 'black'
  maxSeconds?:   number         // hard cap on input length via -t flag
}

export interface MediaOpResult {
  ok:          boolean
  bytes?:      number
  mime?:       string
  videoBase64?: string
  audioBase64?: string
  durationMs:  number
  log?:        string
  error?:      string
}

export async function burnCaptions(input: BurnCaptionsInput): Promise<MediaOpResult> {
  const t0 = Date.now()
  const src = await resolveBytes({
    ...(input.videoBase64 ? { base64: input.videoBase64 } : {}),
    ...(input.videoUrl    ? { url:    input.videoUrl    } : {}),
  })
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }
  if (!input.subtitlesText?.trim()) return { ok: false, durationMs: 0, error: 'subtitlesText required' }

  const dir = await mkdtemp(join(tmpdir(), 'r642-burn-'))
  const ext = input.format ?? 'srt'
  const inPath = join(dir, 'in.mp4')
  const subPath = join(dir, `subs.${ext}`)
  const outPath = join(dir, 'out.mp4')
  try {
    await writeFile(inPath, src.buf)
    await writeFile(subPath, input.subtitlesText, 'utf8')

    const fontSize = Math.max(10, Math.min(96, input.fontSize ?? 24))
    const fontColor = (input.fontColor ?? 'white').replace(/[^a-zA-Z0-9#]/g, '')
    const outlineColor = (input.outlineColor ?? 'black').replace(/[^a-zA-Z0-9#]/g, '')
    // Escape the subtitle path for FFmpeg filter syntax
    const escSub = subPath.replace(/\\/g, '/').replace(/:/g, '\\:')
    const style = `Fontname=DejaVu Sans,Fontsize=${fontSize},PrimaryColour=&H00${fontColor === 'white' ? 'ffffff' : 'ffffff'}&,OutlineColour=&H00${outlineColor === 'black' ? '000000' : '000000'}&,BorderStyle=1,Outline=2,Shadow=1`
    const vf = ext === 'ass'
      ? `ass=${escSub}`
      : `subtitles=${escSub}:force_style='${style}'`

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...(input.maxSeconds ? ['-t', String(Math.max(1, Math.min(600, input.maxSeconds)))] : []),
      '-i', inPath,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'copy',
      outPath,
    ]
    const r = await run('ffmpeg', args, { timeoutMs: 240_000 })
    if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: `ffmpeg ${r.code}`, log: r.stderr.slice(-600) }

    const out = await readFile(outPath)
    return { ok: true, bytes: out.length, mime: 'video/mp4', videoBase64: out.toString('base64'), durationMs: Date.now() - t0 }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── Audio extraction ───────────────────────────────────────────────────────

export interface ExtractAudioInput {
  videoBase64?: string
  videoUrl?:    string
  format?:      'mp3' | 'wav' | 'ogg'
  bitrate?:     string         // 'mp3' default '192k'
}

export async function extractAudio(input: ExtractAudioInput): Promise<MediaOpResult> {
  const t0 = Date.now()
  const src = await resolveBytes({
    ...(input.videoBase64 ? { base64: input.videoBase64 } : {}),
    ...(input.videoUrl    ? { url:    input.videoUrl    } : {}),
  })
  if (!src.ok) return { ok: false, durationMs: 0, error: src.error }

  const fmt = input.format ?? 'mp3'
  const dir = await mkdtemp(join(tmpdir(), 'r642-extract-'))
  const inPath = join(dir, `in${guessExt(src.buf)}`)
  const outPath = join(dir, `out.${fmt}`)
  try {
    await writeFile(inPath, src.buf)
    const codecArgs: string[] = fmt === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', input.bitrate ?? '192k']
      : fmt === 'ogg'
        ? ['-c:a', 'libvorbis']
        : ['-c:a', 'pcm_s16le']
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath, '-vn', ...codecArgs, outPath], { timeoutMs: 180_000 })
    if (!r.ok) return { ok: false, durationMs: Date.now() - t0, error: `ffmpeg ${r.code}`, log: r.stderr.slice(-600) }
    const out = await readFile(outPath)
    const mime = fmt === 'mp3' ? 'audio/mpeg' : fmt === 'ogg' ? 'audio/ogg' : 'audio/wav'
    return { ok: true, bytes: out.length, mime, audioBase64: out.toString('base64'), durationMs: Date.now() - t0 }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function guessExt(buf: Buffer): string {
  // Trivial sniff — most uploads will be .mp4/.webm
  const first = buf.slice(0, 12)
  if (first.includes(Buffer.from('ftyp'))) return '.mp4'
  if (first[0] === 0x1a && first[1] === 0x45 && first[2] === 0xdf && first[3] === 0xa3) return '.webm'
  return '.bin'
}

// ─── Native PDF text path ───────────────────────────────────────────────────

export interface PdfNativeInput {
  pdfBase64?: string
  pdfUrl?:    string
  layout?:    boolean       // preserve text layout (slower, better for tables)
}

export interface PdfNativeResult {
  ok:        boolean
  text:      string
  chars:     number
  durationMs: number
  error?:    string
}

export async function pdfTextNative(input: PdfNativeInput): Promise<PdfNativeResult> {
  const t0 = Date.now()
  const src = await resolveBytes({
    ...(input.pdfBase64 ? { base64: input.pdfBase64 } : {}),
    ...(input.pdfUrl    ? { url:    input.pdfUrl    } : {}),
  })
  if (!src.ok) return { ok: false, text: '', chars: 0, durationMs: 0, error: src.error }

  const dir = await mkdtemp(join(tmpdir(), 'r642-pdf-'))
  const inPath = join(dir, 'in.pdf')
  try {
    await writeFile(inPath, src.buf)
    const args = ['-q', ...(input.layout ? ['-layout'] : []), '-enc', 'UTF-8', inPath, '-']
    const r = await run('pdftotext', args, { timeoutMs: 60_000 })
    if (!r.ok) return { ok: false, text: '', chars: 0, durationMs: Date.now() - t0, error: r.stderr.slice(-300) || `code ${r.code}` }
    const text = r.stdout.replace(/\f/g, '\n\n[Page]\n')
    return { ok: true, text, chars: text.length, durationMs: Date.now() - t0 }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
