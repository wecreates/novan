/**
 * audio-ducking.ts — broadcast-grade music ducking under voiceover.
 *
 * The simple amix the editor agent uses (volume=0.35 on music) is
 * static. This module uses ffmpeg's sidechaincompress filter to ACTUALLY
 * duck the music whenever the voiceover is present, then release smoothly
 * when the voiceover stops. This is what makes TV/radio mixes sound clean.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface DuckOptions {
  /** dB reduction at full ducking. Default -10 dB. */
  reductionDb?: number
  /** ms; how fast the duck engages when voice starts. Default 80ms. */
  attackMs?: number
  /** ms; how fast the duck releases when voice stops. Default 400ms. */
  releaseMs?: number
  /** Threshold dB; voice level that triggers ducking. Default -20 dB. */
  thresholdDb?: number
  /** Compression ratio. Default 8 (heavy duck). */
  ratio?: number
  /** Voice mix gain in dB. Default 0 dB. */
  voiceGainDb?: number
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

/**
 * Duck `musicPath` under `voicePath` and write a mixed result to `outPath`.
 * Use this BEFORE muxing onto the video, then mux the result as the new
 * audio track.
 */
export async function duckMusicUnderVoice(musicPath: string, voicePath: string, outPath: string, opts: DuckOptions = {}): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(musicPath) || !existsSync(voicePath)) return { ok: false, error: 'music or voice missing' }
  try { mkdirSync(dirname(outPath), { recursive: true }) } catch { /* */ }
  const reduction = opts.reductionDb ?? -10
  // sidechaincompress 'makeup' is in dB; ratio + threshold control depth
  const threshold = opts.thresholdDb ?? -20
  const ratio     = opts.ratio       ?? 8
  const attack    = opts.attackMs    ?? 80
  const release   = opts.releaseMs   ?? 400
  const voiceGain = opts.voiceGainDb ?? 0

  // [0:a] = music (target), [1:a] = voice (sidechain key)
  // sidechaincompress: when voice is loud → compress music by ratio
  const filter = [
    `[1:a]volume=${voiceGain}dB,asplit=2[voice_mix][voice_sc]`,
    `[0:a][voice_sc]sidechaincompress=threshold=${(10 ** (threshold / 20)).toFixed(4)}:ratio=${ratio}:attack=${attack}:release=${release}:makeup=1[music_ducked]`,
    `[music_ducked]volume=${reduction}dB[music_final]`,
    `[music_final][voice_mix]amix=inputs=2:duration=longest:dropout_transition=0[a]`,
  ].join(';')

  const r = await runFfmpeg([
    '-y', '-i', musicPath, '-i', voicePath,
    '-filter_complex', filter,
    '-map', '[a]',
    '-c:a', 'aac', '-b:a', '192k', outPath,
  ])
  if (!r.ok || !existsSync(outPath)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}

/**
 * Mux a ducked-mix audio track onto a video. Used by the editor agent.
 */
export async function replaceVideoAudio(videoPath: string, audioPath: string, outPath: string): Promise<{ ok: boolean; error?: string }> {
  if (!existsSync(videoPath) || !existsSync(audioPath)) return { ok: false, error: 'video or audio missing' }
  const r = await runFfmpeg([
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', outPath,
  ])
  if (!r.ok || !existsSync(outPath)) return { ok: false, error: r.stderr.slice(0, 400) }
  return { ok: true }
}

/**
 * Convenience: duck music under voice + mux onto video in one call.
 */
export async function videoDuckedMix(videoPath: string, musicPath: string, voicePath: string, outPath: string, opts: DuckOptions = {}): Promise<{ ok: boolean; error?: string }> {
  // Step 1: produce ducked audio
  const tmpAudio = outPath.replace(/(\.[^.]+)$/, '.duck.aac')
  const duck = await duckMusicUnderVoice(musicPath, voicePath, tmpAudio, opts)
  if (!duck.ok) return duck
  // Step 2: mux onto video
  return replaceVideoAudio(videoPath, tmpAudio, outPath)
}
