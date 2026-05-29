/**
 * voice-audio-codec.ts — pure audio encoding helpers (DUPLICATE).
 *
 * This file is intentionally a verbatim copy of
 * `apps/web/src/hooks/voice-audio-codec.ts`. The browser hook needs the
 * helpers at runtime; the API test suite needs them under vitest. The
 * web app does not yet have its own vitest config, so the canonical
 * tests live in api. Keep the two files byte-identical until a shared
 * package is justified.
 */

const TARGET_SAMPLE_RATE = 16000

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    let s = input[i] ?? 0
    if (s > 1)  s = 1
    if (s < -1) s = -1
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

export function downsampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate <= 0) return new Float32Array(0)
  if (srcRate === TARGET_SAMPLE_RATE) return input
  if (srcRate < TARGET_SAMPLE_RATE) {
    const ratio = TARGET_SAMPLE_RATE / srcRate
    const outLen = Math.floor(input.length * ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.floor(i / ratio)
      out[i] = input[srcIdx] ?? 0
    }
    return out
  }
  const ratio = srcRate / TARGET_SAMPLE_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end   = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    let count = 0
    for (let j = start; j < end; j++) {
      sum += input[j] ?? 0
      count++
    }
    out[i] = count === 0 ? 0 : sum / count
  }
  return out
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  if (typeof btoa !== 'undefined') return btoa(bin)
  const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }
  if (g.Buffer) return g.Buffer.from(bin, 'binary').toString('base64')
  throw new Error('no base64 encoder available')
}

export function isSpeechFrame(pcm: Int16Array, threshold = 600): boolean {
  if (pcm.length === 0) return false
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const s = pcm[i] ?? 0
    sum += s * s
  }
  const rms = Math.sqrt(sum / pcm.length)
  return rms > threshold
}

export const VOICE_AUDIO_CONSTANTS = {
  TARGET_SAMPLE_RATE,
  CHUNK_SIZE_SAMPLES: 320,
} as const
