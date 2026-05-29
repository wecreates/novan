/**
 * thumbnail-generator.ts — produce a high-CTR thumbnail for each video.
 *
 * Two strategies:
 *   1. frame-pick: extract N candidate frames from the video, vision-LLM
 *      ranks them on "thumbnail potential" (face presence, expression,
 *      composition, contrast), then ffmpeg overlays a 3-word title.
 *   2. ai-generate: DALL-E 3 / SDXL via Replicate based on the brief.
 *
 * Output is a 1280x720 JPEG (YouTube spec) or 1080x1920 (Shorts/Reels).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const THUMB_DIR = join(tmpdir(), 'novan-thumbnails')
if (!existsSync(THUMB_DIR)) mkdirSync(THUMB_DIR, { recursive: true })

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface ThumbnailInput {
  videoPath?:    string
  brief:         string
  title?:        string                   // overlay text (≤4 words)
  outPath?:      string
  format?:       'landscape' | 'portrait' // 1280x720 vs 1080x1920
  strategy?:     'frame-pick' | 'ai-generate' | 'auto'
  workspaceId?:  string
}

export interface ThumbnailResult {
  ok:        boolean
  path?:     string
  strategy?: string
  error?:    string
}

async function runFfmpeg(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; stderr: string }> {
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

/** Resolve ffprobe path next to ffmpeg, or honor FFPROBE_BIN env. */
function ffprobePath(): string {
  if (process.env['FFPROBE_BIN']) return process.env['FFPROBE_BIN']
  // Replace only the FINAL "ffmpeg" segment (the executable name), not
  // any occurrence in the path. Handles C:\bin\ffmpeg\ffmpeg.exe → ffprobe.exe.
  return FFMPEG.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext ?? ''}`)
}

/** Extract N candidate frames spaced across the video. */
async function extractCandidates(videoPath: string, count = 8): Promise<string[]> {
  const out: string[] = []
  // Get duration via ffprobe
  const dur = await new Promise<number>((resolve) => {
    let stdout = ''
    const p = spawn(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath], { windowsHide: true })
    p.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    p.on('close', () => resolve(parseFloat(stdout.trim()) || 60))
    p.on('error', () => resolve(60))
  })
  for (let i = 1; i <= count; i++) {
    const t = (dur * i) / (count + 1)
    const dest = join(THUMB_DIR, `cand-${Date.now().toString(36)}-${i}.jpg`)
    const r = await runFfmpeg(['-y', '-ss', t.toFixed(2), '-i', videoPath, '-frames:v', '1', '-q:v', '2', dest])
    if (r.ok && existsSync(dest)) out.push(dest)
  }
  return out
}

/** Vision LLM picks the most thumbnail-worthy frame. */
async function rankFrames(candidates: string[], brief: string): Promise<string> {
  if (candidates.length === 0) throw new Error('no candidates')
  if (candidates.length === 1) return candidates[0]!
  const geminiKey = process.env['GEMINI_API_KEY']
  if (!geminiKey) return candidates[0]!
  try {
    const parts: Array<Record<string, unknown>> = [{ text: `You are a YouTube thumbnail picker. From the ${candidates.length} frames below, pick the SINGLE best thumbnail for a video about: "${brief.slice(0, 200)}".

Criteria (in priority order):
1. Clear, expressive face (if any subject present)
2. High contrast / readable composition
3. Visual surprise or curiosity gap
4. Avoid blur, motion smear, dark frames
5. Avoid frames with text already overlaid

Output STRICT JSON: {"pickIndex": <1-based>, "reason": "<one sentence>"}` }]
    for (const c of candidates) {
      const buf = await readFile(c)
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: buf.toString('base64') } })
    }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env['GEMINI_VISION_MODEL'] ?? 'gemini-2.5-pro'}:generateContent?key=${geminiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1, maxOutputTokens: 200, responseMimeType: 'application/json' } }),
      signal: AbortSignal.timeout(45_000),
    })
    if (r.ok) {
      const j = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const txt = j.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
      const parsed = JSON.parse(txt) as { pickIndex?: number }
      const idx = (parsed.pickIndex ?? 1) - 1
      if (idx >= 0 && idx < candidates.length) return candidates[idx]!
    }
  } catch { /* */ }
  return candidates[0]!
}

/** Overlay title text on the picked frame. */
async function overlayTitle(framePath: string, title: string, format: 'landscape' | 'portrait', outPath: string): Promise<boolean> {
  const isPortrait = format === 'portrait'
  const w = isPortrait ? 1080 : 1280
  const h = isPortrait ? 1920 : 720
  const fontSize = isPortrait ? 96 : 80
  const bottom   = isPortrait ? 360 : 80
  // Escape colons in path for ffmpeg drawtext
  const escTitle = title.replace(/'/g, "\\'").replace(/:/g, '\\:')
  const filter = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    // Dark gradient at bottom for text legibility
    `drawbox=x=0:y=h-${bottom + 40}:w=iw:h=${bottom + 40}:color=black@0.55:t=fill`,
    // Title text — bold sans, white with thick black outline
    `drawtext=text='${escTitle}':fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=h-${bottom}:borderw=6:bordercolor=black:shadowcolor=black@0.6:shadowx=3:shadowy=3`,
  ].join(',')
  const r = await runFfmpeg(['-y', '-i', framePath, '-vf', filter, '-frames:v', '1', '-q:v', '2', outPath])
  return r.ok && existsSync(outPath)
}

async function aiGenerate(brief: string, format: 'landscape' | 'portrait', outPath: string): Promise<boolean> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) return false
  try {
    const size = format === 'portrait' ? '1024x1792' : '1792x1024'
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: `YouTube thumbnail design for a video about: ${brief}. Bold composition, high contrast, single clear subject, expressive, vivid colors, professional photography style. No text or watermarks.`,
        n: 1, size, quality: 'hd',
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) return false
    const j = await r.json() as { data?: Array<{ url?: string }> }
    const url = j.data?.[0]?.url
    if (!url) return false
    const img = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!img.ok) return false
    await writeFile(outPath, Buffer.from(await img.arrayBuffer()))
    return existsSync(outPath)
  } catch { return false }
}

export async function generateThumbnail(input: ThumbnailInput): Promise<ThumbnailResult> {
  const format   = input.format ?? 'landscape'
  const strategy = input.strategy ?? (input.videoPath ? 'frame-pick' : 'ai-generate')
  const outPath  = input.outPath ?? join(THUMB_DIR, `thumb-${Date.now().toString(36)}.jpg`)
  try { mkdirSync(dirname(outPath), { recursive: true }) } catch { /* */ }

  if (strategy === 'frame-pick' || strategy === 'auto') {
    if (input.videoPath && existsSync(input.videoPath)) {
      const candidates = await extractCandidates(input.videoPath, 8)
      if (candidates.length > 0) {
        const picked = await rankFrames(candidates, input.brief)
        if (input.title) {
          const ok = await overlayTitle(picked, input.title, format, outPath)
          if (ok) return { ok: true, path: outPath, strategy: 'frame-pick' }
        } else {
          // Just resize + crop the picked frame to canonical aspect
          const w = format === 'portrait' ? 1080 : 1280
          const h = format === 'portrait' ? 1920 : 720
          const r = await runFfmpeg(['-y', '-i', picked, '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`, '-frames:v', '1', '-q:v', '2', outPath])
          if (r.ok && existsSync(outPath)) return { ok: true, path: outPath, strategy: 'frame-pick' }
        }
      }
    }
    if (strategy === 'frame-pick') return { ok: false, error: 'no video frames usable', strategy }
  }

  // ai-generate (or auto fallback)
  const aiOk = await aiGenerate(input.brief, format, outPath)
  if (aiOk) {
    if (input.title) {
      const titledPath = outPath.replace(/(\.[^.]+)$/, '.titled$1')
      const t = await overlayTitle(outPath, input.title, format, titledPath)
      if (t) return { ok: true, path: titledPath, strategy: 'ai-generate' }
    }
    return { ok: true, path: outPath, strategy: 'ai-generate' }
  }
  return { ok: false, error: 'all thumbnail strategies failed' }
}
