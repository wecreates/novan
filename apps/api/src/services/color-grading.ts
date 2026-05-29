/**
 * color-grading.ts — automatic color correction + creative grading.
 *
 *   autoCorrect(in, out)               — base correction: WB + exposure + contrast
 *   applyGrade(in, out, preset)        — creative look (cinematic / vlog / vintage /
 *                                        moody / clean / warm / cold / teal-orange)
 *   applyLut(in, out, lutPath)         — apply a .cube LUT file
 *
 * Uses ffmpeg with curves + colorbalance + eq + lut3d filters. Genre
 * presets are tuned by hand to match what each style actually does on
 * a scope (waveform + vectorscope).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export type GradePreset =
  | 'cinematic' | 'vlog' | 'vintage' | 'moody' | 'clean'
  | 'warm' | 'cold' | 'teal-orange' | 'bw' | 'punchy'

// Each preset is a chain of ffmpeg video filters tuned to actually look
// like the named style on a real scope, not generic Instagram filters.
const PRESETS: Record<GradePreset, string> = {
  // Slight crushed blacks, lifted shadows toward teal, highlights toward orange
  'teal-orange': `eq=contrast=1.08:saturation=1.12,colorbalance=rs=-0.05:bs=0.10:gh=-0.04:bh=0.05:rh=0.08`,
  // Filmic LUT-like: lifted blacks, slight desaturation, warm midtones
  'cinematic':   `eq=contrast=1.10:brightness=-0.02:saturation=0.92,colorbalance=rs=0.06:bs=-0.04:gh=0.02,curves=preset=increase_contrast`,
  // Bright + airy + clean: high exposure, mild contrast, slight sat lift
  'vlog':        `eq=contrast=1.05:brightness=0.04:saturation=1.10,unsharp=5:5:0.5`,
  // Soft + faded + warm: lifted blacks, reduced saturation, warm tint
  'vintage':     `curves=preset=lighter,eq=saturation=0.78,colorbalance=rs=0.12:gs=0.06:bs=-0.10`,
  // Cool + crushed + dramatic
  'moody':       `eq=contrast=1.20:brightness=-0.05:saturation=0.85,colorbalance=rs=-0.08:bs=0.12:gh=-0.06`,
  // No-op-ish: WB + mild contrast only
  'clean':       `eq=contrast=1.04:saturation=1.02`,
  // Warm sunset-y
  'warm':        `colorbalance=rs=0.15:gs=0.05:bs=-0.10,eq=saturation=1.08`,
  // Cool blue cast
  'cold':        `colorbalance=rs=-0.10:gs=0.03:bs=0.15,eq=saturation=0.94`,
  // High-contrast black and white
  'bw':          `hue=s=0,eq=contrast=1.20:brightness=-0.02`,
  // Punchy social-media saturation + sharpness
  'punchy':      `eq=contrast=1.18:saturation=1.30:gamma=0.92,unsharp=5:5:1.0`,
}

async function runFfmpeg(args: string[], timeoutMs = 30 * 60_000): Promise<{ ok: boolean; stderr: string }> {
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

export async function autoCorrect(inputVideo: string, outputVideo: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(inputVideo)) return { ok: false, error: 'input not found' }
  try { mkdirSync(dirname(outputVideo), { recursive: true }) } catch { /* */ }
  // Auto-WB approximation via colorlevels + mild contrast/sharpening
  const chain = 'colorlevels=rimin=0.02:gimin=0.02:bimin=0.02:rimax=0.96:gimax=0.96:bimax=0.96,eq=contrast=1.05:saturation=1.05,unsharp=5:5:0.4'
  const r = await runFfmpeg(['-y', '-i', inputVideo, '-vf', chain, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outputVideo])
  if (!r.ok || !existsSync(outputVideo)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}

export async function applyGrade(inputVideo: string, outputVideo: string, preset: GradePreset): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(inputVideo)) return { ok: false, error: 'input not found' }
  const chain = PRESETS[preset]
  if (!chain) return { ok: false, error: `unknown preset: ${preset}` }
  try { mkdirSync(dirname(outputVideo), { recursive: true }) } catch { /* */ }
  const r = await runFfmpeg(['-y', '-i', inputVideo, '-vf', chain, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outputVideo])
  if (!r.ok || !existsSync(outputVideo)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}

export async function applyLut(inputVideo: string, outputVideo: string, lutPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(inputVideo) || !existsSync(lutPath)) return { ok: false, error: 'input or LUT missing' }
  const escLut = lutPath.replace(/\\/g, '/').replace(/:/g, '\\:')
  const r = await runFfmpeg(['-y', '-i', inputVideo, '-vf', `lut3d='${escLut}'`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'copy', outputVideo])
  if (!r.ok || !existsSync(outputVideo)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}

export function listPresets(): GradePreset[] {
  return Object.keys(PRESETS) as GradePreset[]
}
