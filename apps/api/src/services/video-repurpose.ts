/**
 * video-repurpose.ts — turn one long-form into N shorts.
 *
 * Pipeline:
 *   1. transcribe long-form (Whisper word-level) → segments
 *   2. score each ~30-60s window by:
 *        - sentence-density (vs filler)
 *        - presence of "hook" keywords (numbers, contrasts, claims)
 *        - LLM rating of "would this stop the scroll?"
 *   3. extract top-N windows via ffmpeg cuts
 *   4. reframe landscape → vertical (center-crop or speaker-track)
 *   5. burn captions via caption-service
 *
 * Output: N vertical mp4 files ready to publish.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const RP_DIR = join(tmpdir(), 'novan-repurpose')
if (!existsSync(RP_DIR)) mkdirSync(RP_DIR, { recursive: true })

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface RepurposeInput {
  longFormPath:  string
  outDir:        string
  count?:        number               // default 6
  durationSec?:  number               // target per clip, default 45
  vertical?:     boolean              // default true (9:16)
  burnCaptions?: boolean              // default true
  workspaceId?:  string
}

export interface ShortClip {
  outPath:    string
  startSec:   number
  endSec:     number
  score:      number
  text:       string
  hookLine:   string
}

export interface RepurposeResult {
  ok:        boolean
  clips:     ShortClip[]
  error?:    string
  durationMs: number
}

async function runFfmpeg(args: string[], timeoutMs = 15 * 60_000): Promise<{ ok: boolean; stderr: string }> {
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

interface Segment { start: number; end: number; text: string }

function scoreSegment(text: string): number {
  let s = 0
  // Numbers / specifics
  if (/\b\d+(?:\.\d+)?(?:%|x|×|k|m|million|billion|years?|days?|seconds?|hours?)\b/i.test(text)) s += 3
  // Contrast words (hooks)
  if (/\b(but|however|actually|surprisingly|despite|even though|the truth|secret|nobody|everyone|wrong|right)\b/i.test(text)) s += 2.5
  // Strong claim words
  if (/\b(best|worst|never|always|only|exactly|literally|insane|crazy|incredible|game-changer|the one thing)\b/i.test(text)) s += 2
  // Questions (engagement)
  if (/\?/.test(text)) s += 1.5
  // Length bonus (longer = more content density)
  s += Math.min(2, text.length / 200)
  // Penalize filler-heavy lines
  if (/\b(um+|uh+|like|you know|kind of|sort of)\b/gi.test(text)) s -= 1
  return s
}

/** Pick N non-overlapping windows that maximize total score. */
function pickWindows(segments: Segment[], targetDur: number, count: number): Array<{ start: number; end: number; text: string; score: number }> {
  // Sliding-window of contiguous segments summing to ~targetDur
  const windows: Array<{ start: number; end: number; text: string; score: number }> = []
  for (let i = 0; i < segments.length; i++) {
    const startSeg = segments[i]!
    let endSeg = startSeg
    let combinedText = startSeg.text
    let j = i
    while (j < segments.length - 1 && endSeg.end - startSeg.start < targetDur) {
      j++
      endSeg = segments[j]!
      combinedText += ' ' + endSeg.text
    }
    const dur = endSeg.end - startSeg.start
    if (dur < targetDur * 0.6 || dur > targetDur * 1.6) continue
    const score = scoreSegment(combinedText) + (dur > targetDur * 0.9 && dur < targetDur * 1.2 ? 1 : 0)
    windows.push({ start: startSeg.start, end: endSeg.end, text: combinedText, score })
  }
  // Greedy non-overlapping pick by score
  windows.sort((a, b) => b.score - a.score)
  const picked: Array<{ start: number; end: number; text: string; score: number }> = []
  for (const w of windows) {
    if (picked.length >= count) break
    const overlaps = picked.some(p => !(w.end <= p.start || w.start >= p.end))
    if (!overlaps) picked.push(w)
  }
  return picked.sort((a, b) => a.start - b.start)
}

/** Cut + reframe one clip. */
async function cutClip(longPath: string, outPath: string, startSec: number, endSec: number, vertical: boolean): Promise<boolean> {
  const dur = (endSec - startSec).toFixed(3)
  const filter = vertical
    ? 'crop=ih*9/16:ih,scale=1080:1920,setsar=1'
    : 'scale=1920:-2,setsar=1'
  const args = ['-y', '-ss', startSec.toFixed(3), '-i', longPath, '-t', dur, '-vf', filter, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', outPath]
  const r = await runFfmpeg(args, 10 * 60_000)
  return r.ok && existsSync(outPath)
}

export async function repurpose(input: RepurposeInput): Promise<RepurposeResult> {
  const t0 = Date.now()
  if (!existsSync(input.longFormPath)) return { ok: false, clips: [], error: 'long-form not found', durationMs: 0 }
  mkdirSync(input.outDir, { recursive: true })

  const count    = Math.max(1, Math.min(20, input.count ?? 6))
  const targetD  = input.durationSec ?? 45
  const vertical = input.vertical !== false
  const burnCap  = input.burnCaptions !== false

  // 1. Transcribe long-form
  const { transcribeToSrt } = await import('./caption-service.js')
  const tr = await transcribeToSrt(input.longFormPath, { wordLevel: false })
  if (!tr.ok || !tr.segments) return { ok: false, clips: [], error: tr.error ?? 'transcription failed', durationMs: Date.now() - t0 }

  // 2-3. Pick + cut
  const windows = pickWindows(tr.segments, targetD, count)
  if (windows.length === 0) return { ok: false, clips: [], error: 'no candidate windows found', durationMs: Date.now() - t0 }

  const clips: ShortClip[] = []
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!
    const stamp = Date.now().toString(36)
    const cutOut = join(input.outDir, `short-${i.toString().padStart(2, '0')}-${stamp}.mp4`)
    const ok = await cutClip(input.longFormPath, cutOut, w.start, w.end, vertical)
    if (!ok) continue
    let finalOut = cutOut
    if (burnCap) {
      // Re-transcribe just this short for tight caption timing
      const srt = await transcribeToSrt(cutOut, { wordLevel: true })
      if (srt.ok && srt.srtPath) {
        const { burnCaptions } = await import('./caption-service.js')
        const burnedOut = cutOut.replace(/\.mp4$/, '.cap.mp4')
        const b = await burnCaptions(cutOut, srt.srtPath, burnedOut, vertical ? { bottomMargin: 700, fontSize: 22 } : {})
        if (b.ok) finalOut = burnedOut
      }
    }
    const hookLine = (w.text.split(/[.!?]\s/)[0] ?? w.text.slice(0, 80)).trim()
    clips.push({ outPath: finalOut, startSec: w.start, endSec: w.end, score: w.score, text: w.text.slice(0, 500), hookLine })
  }

  return { ok: clips.length > 0, clips, durationMs: Date.now() - t0 }
}
