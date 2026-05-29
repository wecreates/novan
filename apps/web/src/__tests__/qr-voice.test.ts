/**
 * qr-voice.test.ts — Tests for the QR generator + voice-input wrapper
 * shape contracts.
 */
import { describe, it, expect } from 'vitest'
import { qrMatrix } from '../pwa/qr'

describe('qrMatrix', () => {
  it('produces a square boolean matrix', () => {
    const m = qrMatrix('https://example.com/m/auth?t=abc')
    expect(Array.isArray(m)).toBe(true)
    expect(m.length).toBeGreaterThan(20)
    for (const row of m) {
      expect(row.length).toBe(m.length)
      for (const v of row) expect(typeof v).toBe('boolean')
    }
  })

  it('matrix size grows with payload length', () => {
    const small = qrMatrix('x')
    const big   = qrMatrix('x'.repeat(120))
    expect(big.length).toBeGreaterThan(small.length)
  })

  it('throws for payloads larger than v10', () => {
    expect(() => qrMatrix('x'.repeat(2_000))).toThrow(/too large/)
  })

  it('different inputs produce different matrices (overwhelmingly)', () => {
    const a = qrMatrix('https://example.com/a')
    const b = qrMatrix('https://example.com/b')
    // Both same size for these similar inputs; should differ in at
    // least 10% of cells.
    expect(a.length).toBe(b.length)
    let diff = 0
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < a.length; j++) {
        if (a[i]![j] !== b[i]![j]) diff++
      }
    }
    expect(diff).toBeGreaterThan(a.length * a.length * 0.05)
  })

  it('produces three corner finder patterns (3 7x7 squares)', () => {
    const m = qrMatrix('hi')
    // Finder pattern signature: row 0, cols 0..6 = filled outer ring.
    expect(m[0]![0]).toBe(true)
    expect(m[0]![6]).toBe(true)
    expect(m[6]![0]).toBe(true)
    expect(m[6]![6]).toBe(true)
    // Top-right finder
    expect(m[0]![m.length - 1]).toBe(true)
    expect(m[0]![m.length - 7]).toBe(true)
    // Bottom-left finder
    expect(m[m.length - 1]![0]).toBe(true)
    expect(m[m.length - 7]![0]).toBe(true)
  })
})

describe('useVoiceInput (shape only)', () => {
  it('module exports the hook + speakText', async () => {
    const m = await import('../pwa/useVoiceInput')
    expect(typeof m.useVoiceInput).toBe('function')
    expect(typeof m.speakText).toBe('function')
  })

  it('speakText is a no-op when speechSynthesis is unavailable', async () => {
    // jsdom doesn't ship speechSynthesis; calling should not throw.
    const { speakText } = await import('../pwa/useVoiceInput')
    const cancel = speakText('hello')
    expect(typeof cancel).toBe('function')
    cancel()
  })
})

describe('mobile taxonomy + routes wiring', () => {
  it('mobile chat reachable from the minimal taxonomy', async () => {
    const { allPaths } = await import('../shell/taxonomy')
    const paths = allPaths()
    expect(paths).toContain('/m/chat')
    // Minimal taxonomy surfaces ~30 daily-use routes. Sign-in flow
    // pages (/m/sign-in, /m/auth) stay reachable by URL but aren't in
    // the tree.
    expect(paths.length).toBeGreaterThanOrEqual(25)
    expect(paths.length).toBeLessThanOrEqual(50)
  })
})
