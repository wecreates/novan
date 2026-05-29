/**
 * caption-service.ts — Whisper-driven captions for video.
 *
 *   transcribeToSrt(audioOrVideoPath)        — Whisper → SRT (word-timed)
 *   burnCaptions(videoPath, srtPath, out)    — ffmpeg subtitle burn-in
 *                                              with bold high-contrast
 *                                              styling tuned for vertical
 *                                              shorts (TikTok / Reels).
 *
 * Used by the editor agent after CapCut export to produce a captioned
 * variant (CapCut auto-caption works but the brain owning the SRT lets
 * us A/B caption styles and burn at known font/size/position).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const CAP_DIR = join(tmpdir(), 'novan-captions')
if (!existsSync(CAP_DIR)) mkdirSync(CAP_DIR, { recursive: true })

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface SrtSegment { start: number; end: number; text: string }

async function runFfmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    let proc
    try { proc = spawn(FFMPEG, args, { windowsHide: true }) }
    catch (e) { resolve({ ok: false, stderr: (e as Error).message }); return }
    const t = setTimeout(() => proc!.kill('SIGTERM'), timeoutMs)
    proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    proc.on('close', (c) => { clearTimeout(t); resolve({ ok: c === 0, stderr }) })
    proc.on('error', (e) => { clearTimeout(t); resolve({ ok: false, stderr: e.message }) })
  })
}

/** Extract audio to mp3 for Whisper (smaller upload). */
async function extractAudio(input: string): Promise<string | null> {
  const dest = join(CAP_DIR, `aud-${Date.now().toString(36)}.mp3`)
  const r = await runFfmpeg(['-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '64k', dest], 5 * 60_000)
  return r.ok && existsSync(dest) ? dest : null
}

function fmtTs(sec: number): string {
  const ms = Math.floor((sec - Math.floor(sec)) * 1000)
  const s  = Math.floor(sec) % 60
  const m  = Math.floor(sec / 60) % 60
  const h  = Math.floor(sec / 3600)
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`
}

export function segmentsToSrt(segments: SrtSegment[]): string {
  return segments.map((s, i) => `${i + 1}\n${fmtTs(s.start)} --> ${fmtTs(s.end)}\n${s.text.trim()}`).join('\n\n') + '\n'
}

export async function transcribeToSrt(videoOrAudioPath: string, opts?: { wordLevel?: boolean }): Promise<{ ok: boolean; srtPath?: string; segments?: SrtSegment[]; error?: string }> {
  if (!existsSync(videoOrAudioPath)) return { ok: false, error: 'input not found' }
  const audioPath = videoOrAudioPath.match(/\.(mp3|wav|m4a|flac|ogg)$/i) ? videoOrAudioPath : await extractAudio(videoOrAudioPath)
  if (!audioPath) return { ok: false, error: 'audio extraction failed' }
  const buf = await readFile(audioPath)

  // Try Groq (fast + free) → OpenAI
  const tryProvider = async (url: string, key: string, model: string, granularity: 'segment' | 'word'): Promise<SrtSegment[] | null> => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'audio/mpeg' }), 'audio.mp3')
    form.append('model', model)
    form.append('response_format', 'verbose_json')
    if (granularity === 'word') form.append('timestamp_granularities[]', 'word')
    try {
      const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(300_000) })
      if (!r.ok) return null
      const j = await r.json() as {
        segments?: Array<{ start: number; end: number; text: string }>
        words?:    Array<{ start: number; end: number; word: string }>
      }
      if (opts?.wordLevel && j.words) {
        // Group words into 3-5 word caption chunks for vertical-short readability
        const chunks: SrtSegment[] = []
        let buf2: { start: number; end: number; text: string } | null = null
        let count = 0
        for (const w of j.words) {
          if (!buf2) { buf2 = { start: w.start, end: w.end, text: w.word.trim() }; count = 1; continue }
          buf2.end = w.end; buf2.text += ' ' + w.word.trim(); count++
          if (count >= 4) { chunks.push(buf2); buf2 = null; count = 0 }
        }
        if (buf2) chunks.push(buf2)
        return chunks
      }
      return (j.segments ?? []).map(s => ({ start: s.start, end: s.end, text: s.text }))
    } catch { return null }
  }

  const groqKey = process.env['GROQ_API_KEY']
  let segments: SrtSegment[] | null = null
  if (groqKey) segments = await tryProvider('https://api.groq.com/openai/v1/audio/transcriptions', groqKey, process.env['GROQ_WHISPER_MODEL'] ?? 'whisper-large-v3', opts?.wordLevel ? 'word' : 'segment')
  if (!segments) {
    const openaiKey = process.env['OPENAI_API_KEY']
    if (openaiKey) segments = await tryProvider('https://api.openai.com/v1/audio/transcriptions', openaiKey, 'whisper-1', opts?.wordLevel ? 'word' : 'segment')
  }
  if (!segments || segments.length === 0) return { ok: false, error: 'no transcript produced' }

  const srt = segmentsToSrt(segments)
  const srtPath = join(CAP_DIR, `cap-${Date.now().toString(36)}.srt`)
  await writeFile(srtPath, srt, 'utf8')
  return { ok: true, srtPath, segments }
}

/**
 * Burn captions onto video. Styling defaults are tuned for vertical
 * shorts: bold sans-serif, white with black outline + drop shadow,
 * positioned 28% from bottom (TikTok-safe zone).
 */
export interface BurnOptions {
  fontName?:   string          // default 'Arial Black'
  fontSize?:   number          // default 18 (short) / 14 (long)
  primaryColor?: string        // ASS color, default white &HFFFFFF&
  outlineColor?: string        // default black &H000000&
  outlineWidth?: number        // default 3
  bottomMargin?: number        // px from bottom, default 250 (vertical)
  bold?: boolean
}

export async function burnCaptions(videoPath: string, srtPath: string, outPath: string, opts: BurnOptions = {}): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(videoPath) || !existsSync(srtPath)) return { ok: false, error: 'video or srt missing' }
  try { mkdirSync(dirname(outPath), { recursive: true }) } catch { /* */ }
  const font   = opts.fontName ?? 'Arial Black'
  const size   = opts.fontSize ?? 18
  const margin = opts.bottomMargin ?? 250
  const bold   = opts.bold === false ? 0 : 1
  // libass force_style: Bold + outline + shadow for max legibility.
  // Windows path escape: forward slashes + escape colons + escape
  // backslashes-in-quoted strings (yes, ffmpeg-filter quoting is a
  // multi-layer nightmare). Drive letter colon C: → C\: but inside
  // single-quoted filter values it actually needs C\\: due to the
  // filter parser unescaping once before libass sees it.
  const escSrt = srtPath
    .replace(/\\/g, '/')                // backslashes → forward
    .replace(/:/g, '\\\\:')             // colons → \\:  (double-escape for ffmpeg-filter quoting)
  const style  = `FontName=${font},FontSize=${size},PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=${opts.outlineWidth ?? 3},Shadow=1,MarginV=${margin},Bold=${bold},Alignment=2`
  const filter = `subtitles='${escSrt}':force_style='${style}'`
  const r = await runFfmpeg(['-y', '-i', videoPath, '-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outPath], 30 * 60_000)
  if (!r.ok || !existsSync(outPath)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}
