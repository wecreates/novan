/**
 * brain-showcase-anonymize.test.ts — Pure-function tests for the
 * presentation-mode privacy transforms.
 */
import { describe, it, expect } from 'vitest'
import {
  aliasFor, roundCurrency, roundCount, redactText, anonymize,
  formatAmount, formatCount, DEFAULT_ANON,
} from '../components/brain-showcase/anonymize'

describe('aliasFor', () => {
  it('is deterministic for the same input', () => {
    expect(aliasFor('AcmeCorp')).toBe(aliasFor('AcmeCorp'))
  })
  it('returns different aliases for distinct inputs (usually)', () => {
    const set = new Set(['Acme', 'BrandX', 'Studio42', 'Etsy Shop A', 'OnlyFans'].map(aliasFor))
    expect(set.size).toBeGreaterThanOrEqual(3)
  })
  it('handles empty input', () => {
    expect(aliasFor('')).toBe('Workspace')
  })
  it('uses the pool of celestial-themed aliases', () => {
    const a = aliasFor('test-input-here')
    expect(['Orion','Lyra','Cygnus','Vega','Andromeda','Atlas','Helios','Polaris','Sirius','Rigel','Antares','Auriga','Draco','Phoenix','Nova','Aurora','Eclipse','Quasar','Pulsar','Nebula']).toContain(a)
  })
})

describe('roundCurrency', () => {
  it('handles zero and tiny amounts', () => {
    expect(roundCurrency(0)).toBe('$0')
    expect(roundCurrency(50)).toBe('<$1k')
    expect(roundCurrency(-50)).toBe('-<$1k')
  })
  it('rounds thousands', () => {
    expect(roundCurrency(3_400)).toBe('$3k')
    expect(roundCurrency(9_900)).toBe('$10k')
  })
  it('rounds tens of thousands', () => {
    expect(roundCurrency(47_200)).toBe('~$50k')
  })
  it('rounds hundreds of thousands', () => {
    expect(roundCurrency(280_000)).toBe('~$300k')
  })
  it('rounds millions', () => {
    expect(roundCurrency(2_400_000)).toBe('~$2.4M')
    expect(roundCurrency(15_000_000)).toBe('~$15M')
  })
})

describe('roundCount', () => {
  it('preserves small ints', () => {
    expect(roundCount(7)).toBe('7')
  })
  it('rounds tens', () => {
    expect(roundCount(47)).toBe('~50')
  })
  it('rounds hundreds to nearest 50', () => {
    expect(roundCount(327)).toBe('~350')   // 327 / 50 = 6.54 → 7 × 50 = 350
    expect(roundCount(310)).toBe('~300')   // 310 / 50 = 6.2  → 6 × 50 = 300
  })
  it('rounds thousands', () => {
    expect(roundCount(12_000)).toBe('~12k')
  })
})

describe('redactText', () => {
  it('redacts email shapes', () => {
    const out = redactText('contact alice@example.com today')
    expect(out).not.toContain('alice@example.com')
    expect(out).toContain('████')
  })
  it('redacts SSN-shape numbers', () => {
    expect(redactText('SSN 123-45-6789')).not.toContain('123-45-6789')
  })
  it('redacts phone-shape numbers', () => {
    const out = redactText('call +1 (415) 555-1234')
    expect(out).not.toContain('555-1234')
  })
  it('passes through harmless text', () => {
    expect(redactText('Hello world, no PII here.')).toBe('Hello world, no PII here.')
  })
})

describe('anonymize', () => {
  it('aliases business + operator names by default', () => {
    const out = anonymize({ name: 'AcmeCo', operator: 'Alice Smith' })
    expect(out.name).not.toBe('AcmeCo')
    expect(out.operator).not.toBe('Alice Smith')
  })
  it('preserves amount numerically (display layer formats)', () => {
    const out = anonymize({ amount: 47_200 })
    expect(out.amount).toBe(47_200)
  })
  it('redacts text', () => {
    const out = anonymize({ text: 'Email me at me@x.com' })
    expect(out.text).not.toContain('me@x.com')
  })
  it('respects partial opt-out', () => {
    const out = anonymize({ name: 'AcmeCo' }, { hideBusinessNames: false })
    expect(out.name).toBe('AcmeCo')
  })
  it('DEFAULT_ANON enables all flags', () => {
    expect(DEFAULT_ANON.hideBusinessNames).toBe(true)
    expect(DEFAULT_ANON.hideOperatorNames).toBe(true)
    expect(DEFAULT_ANON.roundFinancials).toBe(true)
    expect(DEFAULT_ANON.redactPii).toBe(true)
  })
})

describe('format helpers', () => {
  it('formatAmount returns rounded when anon on, exact when off', () => {
    expect(formatAmount(47_200, true)).toBe('~$50k')
    expect(formatAmount(47_200, false)).toBe('$47,200')
  })
  it('formatCount returns rounded when anon on, exact when off', () => {
    expect(formatCount(327, true)).toBe('~350')
    expect(formatCount(327, false)).toBe('327')
  })
})
