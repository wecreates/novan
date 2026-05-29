/**
 * Tests for tts-bridge.ts — pure validators.
 * Network paths (probeSidecar/synthesize) are integration-tested against
 * a running sidecar; here we cover the input gating that runs before
 * any HTTP call.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import { validateRefPath, isSupportedLanguage, validateProfileName } from '../services/tts-bridge.js'

const ROOT = '/safe/voice-refs'

// ─── validateRefPath ───────────────────────────────────────────────────

describe('tts-bridge: validateRefPath', () => {
  it('accepts a clean relative path', () => {
    const r = validateRefPath('ws_dev/morgan.wav', ROOT)
    expect(r.ok).toBe(true)
    expect(r.rel).toBe('ws_dev/morgan.wav')
    expect(r.abs).toMatch(/morgan\.wav$/)
  })

  it('rejects an empty string', () => {
    expect(validateRefPath('', ROOT).ok).toBe(false)
  })

  it('rejects path traversal', () => {
    const r = validateRefPath('../../../etc/passwd', ROOT)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/traversal/i)
  })

  it('rejects absolute paths', () => {
    expect(validateRefPath('/etc/passwd', ROOT).ok).toBe(false)
    expect(validateRefPath('C:\\Windows\\file.wav', ROOT).ok).toBe(false)
  })

  it('rejects paths that resolve outside the root', () => {
    // Using a clever combination of valid-looking segments
    const r = validateRefPath('./..//outside.wav', ROOT)
    expect(r.ok).toBe(false)
  })

  it('rejects an unknown audio extension', () => {
    const r = validateRefPath('clip.exe', ROOT)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/extension/i)
  })

  it('rejects no extension', () => {
    const r = validateRefPath('voicefile', ROOT)
    expect(r.ok).toBe(false)
  })

  it('accepts each supported audio extension', () => {
    for (const ext of ['wav', 'mp3', 'flac', 'ogg']) {
      const r = validateRefPath(`sample.${ext}`, ROOT)
      expect(r.ok).toBe(true)
    }
  })

  it('rejects paths longer than 300 chars', () => {
    const r = validateRefPath('x'.repeat(310) + '.wav', ROOT)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too long/i)
  })
})

// ─── isSupportedLanguage ───────────────────────────────────────────────

describe('tts-bridge: isSupportedLanguage', () => {
  it('accepts common XTTS-v2 languages', () => {
    for (const code of ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh-cn']) {
      expect(isSupportedLanguage(code)).toBe(true)
    }
  })

  it('case-insensitive', () => {
    expect(isSupportedLanguage('EN')).toBe(true)
    expect(isSupportedLanguage('Zh-CN')).toBe(true)
  })

  it('rejects bogus codes', () => {
    expect(isSupportedLanguage('xx')).toBe(false)
    expect(isSupportedLanguage('klingon')).toBe(false)
    expect(isSupportedLanguage('')).toBe(false)
  })
})

// ─── validateProfileName ───────────────────────────────────────────────

describe('tts-bridge: validateProfileName', () => {
  it('accepts a normal name', () => {
    expect(validateProfileName('Default Voice').ok).toBe(true)
  })

  it('rejects empty / whitespace-only', () => {
    expect(validateProfileName('').ok).toBe(false)
    expect(validateProfileName('    ').ok).toBe(false)
  })

  it('caps name length at 80', () => {
    expect(validateProfileName('a'.repeat(81)).ok).toBe(false)
    expect(validateProfileName('a'.repeat(80)).ok).toBe(true)
  })

  it('rejects non-string input', () => {
    expect(validateProfileName(42 as unknown as string).ok).toBe(false)
  })
})
