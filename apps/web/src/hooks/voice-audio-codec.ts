/**
 * voice-audio-codec.ts — pure audio encoding helpers.
 *
 * Both Gemini Live and Deepgram accept raw PCM16 frames over WebSocket
 * at fixed sample rates (Gemini: 16000 Hz mono LE, Deepgram: 16000 Hz
 * mono LE). The browser's MediaStream + AudioWorklet/ScriptProcessor
 * produces Float32 samples in [-1, 1] at the AudioContext's native rate
 * (usually 48000 Hz). This module is the pure conversion layer.
 *
 * Exports:
 *   floatToPcm16(float32)      — clamp + scale + 16-bit LE encode
 *   downsampleTo16k(buf, srcRate) — naive sample-rate conversion (decimation
 *                                   + averaging) since the browser doesn't
 *                                   ship a resampler for arbitrary rates
 *   pcm16ToBase64(pcm)         — for vendors that prefer base64 framing
 *
 * No browser APIs touched here. Tests cover every helper.
 */

const TARGET_SAMPLE_RATE = 16000

/** Pure: Float32 [-1, 1] → 16-bit signed little-endian Int16Array. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    let s = input[i] ?? 0
    if (s > 1)  s = 1
    if (s < -1) s = -1
    // Round to nearest, not truncate, so silence stays at 0.
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff)
  }
  return out
}

/**
 * Pure: downsample to 16 kHz. The input rate is whatever the operator's
 * AudioContext gave us — typically 44.1 or 48 kHz. We average across
 * each window so we get a low-pass-ish effect for free without shipping
 * a real anti-aliasing filter. Good enough for speech; not for music.
 *
 *   downsampleTo16k(buf, 48000) → ~1/3 the samples
 *   downsampleTo16k(buf, 16000) → returns the buffer unchanged
 *   downsampleTo16k(buf, 8000)  → upsamples (repeats samples)
 */
export function downsampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate <= 0) return new Float32Array(0)
  if (srcRate === TARGET_SAMPLE_RATE) return input
  if (srcRate < TARGET_SAMPLE_RATE) {
    // Upsample by nearest-neighbor; this is the cheap path.
    const ratio = TARGET_SAMPLE_RATE / srcRate
    const outLen = Math.floor(input.length * ratio)
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.floor(i / ratio)
      out[i] = input[srcIdx] ?? 0
    }
    return out
  }
  // Downsample by averaging each window of `ratio` samples.
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

/** Pure: Int16Array → base64 string. Some vendors prefer this framing. */
export function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  // Build a binary string from bytes; browser+Node both support btoa
  // on global. Tests run under jsdom which provides btoa.
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  if (typeof btoa !== 'undefined') return btoa(bin)
  // Fallback for environments without btoa (very old Node).
  // Buffer is Node-only; guard with typeof.
  const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }
  if (g.Buffer) return g.Buffer.from(bin, 'binary').toString('base64')
  throw new Error('no base64 encoder available')
}

/**
 * Pure: simple voice-activity heuristic. Returns true when the RMS
 * energy of the buffer exceeds the threshold. Used to suppress
 * sending pure silence to the provider (cost + latency win).
 */
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
  /** Chunk size in samples at 16 kHz (~20 ms per chunk). */
  CHUNK_SIZE_SAMPLES: 320,
} as const
