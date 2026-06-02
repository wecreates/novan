/**
 * Tests for ai-quality-directive.ts
 *
 * Verifies the directive is prepended to every LLM system prompt and
 * appended to every image prompt, and that both are idempotent so a
 * second pass doesn't double-inject.
 */
import { describe, it, expect } from 'vitest'
import {
  QUALITY_BAR_TEXT,
  QUALITY_BAR_IMAGE,
  injectQualityBarIntoMessages,
  injectQualityBarIntoImagePrompt,
} from '../services/ai-quality-directive.js'

describe('injectQualityBarIntoMessages', () => {
  it('prepends to an existing system message', () => {
    const out = injectQualityBarIntoMessages([
      { role: 'system', content: 'You are a niche scorer.' },
      { role: 'user',   content: 'score: dropshipping' },
    ])
    expect(out[0]?.role).toBe('system')
    expect(out[0]?.content.startsWith('[QUALITY BAR')).toBe(true)
    expect(out[0]?.content.includes('You are a niche scorer.')).toBe(true)
    expect(out[1]?.role).toBe('user')
  })

  it('inserts a new system message when none present', () => {
    const out = injectQualityBarIntoMessages([
      { role: 'user', content: 'hello' },
    ])
    expect(out.length).toBe(2)
    expect(out[0]?.role).toBe('system')
    expect(out[0]?.content).toBe(QUALITY_BAR_TEXT)
    expect(out[1]?.role).toBe('user')
  })

  it('is idempotent (no double-prepend)', () => {
    const once  = injectQualityBarIntoMessages([{ role: 'system', content: 'X' }, { role: 'user', content: 'Y' }])
    const twice = injectQualityBarIntoMessages(once)
    expect(twice).toEqual(once)
  })

  it('handles empty messages list', () => {
    expect(injectQualityBarIntoMessages([])).toEqual([])
  })
})

describe('injectQualityBarIntoImagePrompt', () => {
  it('appends quality suffix to a prompt', () => {
    const out = injectQualityBarIntoImagePrompt('a cat sitting on a fence')
    expect(out.startsWith('a cat sitting on a fence')).toBe(true)
    expect(out.includes('high detail, sharp focus, professional composition')).toBe(true)
  })

  it('is idempotent', () => {
    const once  = injectQualityBarIntoImagePrompt('logo concept')
    const twice = injectQualityBarIntoImagePrompt(once)
    expect(twice).toBe(once)
  })

  it('returns empty string for empty prompt', () => {
    expect(injectQualityBarIntoImagePrompt('')).toBe('')
  })

  it('trims whitespace before appending', () => {
    const out = injectQualityBarIntoImagePrompt('  prompt with spaces  ')
    expect(out.startsWith('prompt with spaces,')).toBe(true)
  })
})

describe('QUALITY_BAR constants', () => {
  it('text directive contains key rules', () => {
    expect(QUALITY_BAR_TEXT).toContain('Production-grade')
    expect(QUALITY_BAR_TEXT).toContain('fabricate')
    expect(QUALITY_BAR_TEXT).toContain('Smallest correct change')
  })
  it('image suffix contains visual quality keywords', () => {
    expect(QUALITY_BAR_IMAGE).toContain('high detail')
    expect(QUALITY_BAR_IMAGE).toContain('sharp focus')
    expect(QUALITY_BAR_IMAGE).toContain('no extra fingers')
  })
})
