/**
 * Tests for voice-audio-codec — pure PCM16 encoding helpers shared by
 * the browser-side Gemini Live / Deepgram adapters.
 */
import { describe, it, expect } from 'vitest'
import {
  floatToPcm16, downsampleTo16k, pcm16ToBase64, isSpeechFrame, VOICE_AUDIO_CONSTANTS,
} from '../services/voice-audio-codec.js'

// ─── floatToPcm16 ──────────────────────────────────────────────────────

describe('floatToPcm16', () => {
  it('zero stays at zero', () => {
    const out = floatToPcm16(new Float32Array([0, 0, 0]))
    expect(Array.from(out)).toEqual([0, 0, 0])
  })

  it('1.0 maps to max positive int16', () => {
    const out = floatToPcm16(new Float32Array([1]))
    expect(out[0]).toBe(0x7fff)
  })

  it('-1.0 maps to min negative int16', () => {
    const out = floatToPcm16(new Float32Array([-1]))
    expect(out[0]).toBe(-0x8000)
  })

  it('clamps values above 1.0', () => {
    expect(floatToPcm16(new Float32Array([2.5]))[0]).toBe(0x7fff)
  })

  it('clamps values below -1.0', () => {
    expect(floatToPcm16(new Float32Array([-2.5]))[0]).toBe(-0x8000)
  })

  it('preserves array length', () => {
    expect(floatToPcm16(new Float32Array(1024)).length).toBe(1024)
  })

  it('rounds to nearest int', () => {
    // 0.5 * 0x7fff = 16383.5 → rounds to 16384
    expect(floatToPcm16(new Float32Array([0.5]))[0]).toBe(16384)
  })
})

// ─── downsampleTo16k ───────────────────────────────────────────────────

describe('downsampleTo16k', () => {
  it('returns input unchanged at 16 kHz', () => {
    const buf = new Float32Array([0.1, 0.2, 0.3])
    const out = downsampleTo16k(buf, 16000)
    expect(out).toBe(buf)
  })

  it('downsamples 48 kHz by ~3x', () => {
    const buf = new Float32Array(48_000)
    const out = downsampleTo16k(buf, 48000)
    expect(out.length).toBe(16_000)
  })

  it('downsamples 44.1 kHz proportionally', () => {
    const buf = new Float32Array(44_100)
    const out = downsampleTo16k(buf, 44100)
    expect(out.length).toBe(16_000)
  })

  it('upsamples 8 kHz', () => {
    const buf = new Float32Array(8_000)
    const out = downsampleTo16k(buf, 8000)
    expect(out.length).toBe(16_000)
  })

  it('averages windows when downsampling (low-pass effect)', () => {
    // 4-sample input @ 32 kHz → 2-sample output @ 16 kHz, each = avg(2)
    const buf = new Float32Array([1, 0, 0.5, 0.5])
    const out = downsampleTo16k(buf, 32000)
    expect(out.length).toBe(2)
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[1]).toBeCloseTo(0.5, 5)
  })

  it('returns empty for invalid src rate', () => {
    expect(downsampleTo16k(new Float32Array([1, 2]), 0).length).toBe(0)
    expect(downsampleTo16k(new Float32Array([1, 2]), -1).length).toBe(0)
  })
})

// ─── pcm16ToBase64 ─────────────────────────────────────────────────────

describe('pcm16ToBase64', () => {
  it('encodes a known sample', () => {
    // Int16 [256, 0] in LE bytes = [0x00, 0x01, 0x00, 0x00] = AAEAAA==
    const out = pcm16ToBase64(new Int16Array([256, 0]))
    expect(out).toBe('AAEAAA==')
  })

  it('encodes empty input to empty string', () => {
    expect(pcm16ToBase64(new Int16Array(0))).toBe('')
  })

  it('preserves byte count (decodable round-trip)', () => {
    const pcm = new Int16Array([100, -100, 200, -200])
    const b64 = pcm16ToBase64(pcm)
    // base64 length = ceil(bytes / 3) * 4 = ceil(8/3)*4 = 12
    expect(b64.length).toBe(12)
  })
})

// ─── isSpeechFrame ─────────────────────────────────────────────────────

describe('isSpeechFrame', () => {
  it('silence is not speech', () => {
    expect(isSpeechFrame(new Int16Array(320))).toBe(false)
  })

  it('loud signal is speech', () => {
    const loud = new Int16Array(320).fill(10_000)
    expect(isSpeechFrame(loud)).toBe(true)
  })

  it('empty buffer is not speech', () => {
    expect(isSpeechFrame(new Int16Array(0))).toBe(false)
  })

  it('respects a custom threshold', () => {
    const quiet = new Int16Array(320).fill(100)
    expect(isSpeechFrame(quiet, 50)).toBe(true)
    expect(isSpeechFrame(quiet, 1000)).toBe(false)
  })
})

describe('VOICE_AUDIO_CONSTANTS', () => {
  it('exposes target sample rate + chunk size', () => {
    expect(VOICE_AUDIO_CONSTANTS.TARGET_SAMPLE_RATE).toBe(16000)
    expect(VOICE_AUDIO_CONSTANTS.CHUNK_SIZE_SAMPLES).toBe(320)
  })
})
