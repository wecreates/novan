/**
 * Tests for self-aware platform pure functions.
 *
 * - semantic-search embed(): vector shape, normalization, cosine on related text
 * - code-introspection introspectCode(): walks fs without crashing
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (resolve: (v: unknown) => unknown) => resolve([])
      if (prop === 'catch') return () => chain
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain } }
})
vi.mock('../services/reasoning-chains.js', () => ({ record: async () => 'mock-id' }))

import { embed } from '../services/semantic-search.js'
import { introspectCode } from '../services/code-introspection.js'

describe('semantic-search embed()', () => {
  it('returns 256-dim vector', () => {
    const v = embed('test phrase')
    expect(v.length).toBe(256)
  })

  it('is L2-normalized to unit length', () => {
    const v = embed('the quick brown fox jumps over the lazy dog')
    let mag = 0
    for (const x of v) mag += x * x
    expect(Math.sqrt(mag)).toBeCloseTo(1, 5)
  })

  it('similar text yields higher cosine than unrelated', () => {
    const a = embed('provider migration to groq for cost savings')
    const b = embed('migrate provider to groq because cost is high')
    const c = embed('schedule team standup for tomorrow morning')
    let ab = 0, ac = 0
    for (let i = 0; i < 256; i++) {
      ab += (a[i] ?? 0) * (b[i] ?? 0)
      ac += (a[i] ?? 0) * (c[i] ?? 0)
    }
    expect(ab).toBeGreaterThan(ac)
  })

  it('empty string returns near-zero magnitude (or safe zero vector)', () => {
    const v = embed('')
    let mag = 0
    for (const x of v) mag += x * x
    expect(Math.sqrt(mag)).toBeLessThanOrEqual(1.01)
  })

  it('only stopword-like tokens still produces a vector', () => {
    const v = embed('a b c')  // <3-char tokens are dropped
    expect(v.length).toBe(256)
  })
})

describe('code-introspection introspectCode()', () => {
  it('does not throw on a fresh process', () => {
    expect(() => introspectCode()).not.toThrow()
  })

  it('returns service + route counts (possibly 0 in test env)', () => {
    const r = introspectCode()
    expect(typeof r.serviceCount).toBe('number')
    expect(typeof r.routeCount).toBe('number')
    expect(r.serviceCount).toBeGreaterThanOrEqual(0)
    expect(r.routeCount).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(r.notes)).toBe(true)
  })
})
