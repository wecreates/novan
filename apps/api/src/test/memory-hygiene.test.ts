/**
 * Tests for memory-hygiene (#45) — stale pruning + contradiction +
 * duplicate detection. Pure helpers covered by fixtures.
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

import { scoreMemoryEntry, detectContradictions, detectDuplicates, type MemoryEntry } from '../services/memory-hygiene.js'

const NOW = 1_700_000_000_000

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'e1', kind: 'fact', content: 'something',
    confidence: 0.8, createdAt: NOW - 86_400_000, lastUsedAt: NOW - 86_400_000, useCount: 1,
    ...over,
  }
}

// ─── scoreMemoryEntry ──────────────────────────────────────────────────

describe('memory-hygiene: scoreMemoryEntry', () => {
  it('high-confidence recent entry → keep', () => {
    const r = scoreMemoryEntry(entry({ confidence: 0.9, createdAt: NOW - 86_400_000, useCount: 5 }), NOW)
    expect(r.verdict).toBe('keep')
  })

  it('old, unused, low-confidence entry → prune', () => {
    const r = scoreMemoryEntry(entry({ confidence: 0.3, createdAt: NOW - 90 * 86_400_000, useCount: 0, lastUsedAt: NOW - 90 * 86_400_000 }), NOW)
    expect(r.verdict).toBe('prune')
  })

  it('confidence decays with age', () => {
    const fresh = scoreMemoryEntry(entry({ confidence: 0.8, createdAt: NOW - 86_400_000 }), NOW)
    const aged  = scoreMemoryEntry(entry({ confidence: 0.8, createdAt: NOW - 60 * 86_400_000 }), NOW)
    expect(aged.retainScore).toBeLessThan(fresh.retainScore)
  })

  it('high use count rescues an aging entry', () => {
    const r = scoreMemoryEntry(entry({ confidence: 0.5, createdAt: NOW - 20 * 86_400_000, useCount: 8, lastUsedAt: NOW - 86_400_000 }), NOW)
    expect(r.verdict).not.toBe('prune')
  })

  it('TTL exceeded + low usage forces prune even with high confidence', () => {
    const r = scoreMemoryEntry(entry({ confidence: 0.9, createdAt: NOW - 70 * 86_400_000, useCount: 1, lastUsedAt: NOW - 70 * 86_400_000 }), NOW)
    expect(r.verdict).toBe('prune')
    expect(r.reasons.some(s => s.startsWith('ttl-exceeded'))).toBe(true)
  })

  it('retention score stays within [0,1]', () => {
    const r = scoreMemoryEntry(entry({ confidence: 1.5, useCount: 999 }), NOW)
    expect(r.retainScore).toBeLessThanOrEqual(1)
    expect(r.retainScore).toBeGreaterThanOrEqual(0)
  })
})

// ─── detectContradictions ──────────────────────────────────────────────

describe('memory-hygiene: detectContradictions', () => {
  it('detects polar conflicts within the same kind', () => {
    const r = detectContradictions([
      entry({ id: 'a', kind: 'runtime_status', content: 'service X is up' }),
      entry({ id: 'b', kind: 'runtime_status', content: 'service X is down' }),
    ])
    expect(r.length).toBe(1)
    expect(r[0]!.aId).toBe('a')
    expect(r[0]!.bId).toBe('b')
  })

  it('detects success/failure conflicts', () => {
    const r = detectContradictions([
      entry({ id: 'a', kind: 'deploy', content: 'deploy succeeded' }),
      entry({ id: 'b', kind: 'deploy', content: 'deploy failed' }),
    ])
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('does not flag entries across different kinds', () => {
    const r = detectContradictions([
      entry({ id: 'a', kind: 'runtime',  content: 'X is up' }),
      entry({ id: 'b', kind: 'database', content: 'X is down' }),
    ])
    expect(r.length).toBe(0)
  })

  it('agreement is not a contradiction', () => {
    const r = detectContradictions([
      entry({ id: 'a', kind: 'runtime_status', content: 'X is up' }),
      entry({ id: 'b', kind: 'runtime_status', content: 'X is up and healthy' }),
    ])
    expect(r.length).toBe(0)
  })

  it('reports confidence delta for each contradiction', () => {
    const r = detectContradictions([
      entry({ id: 'a', kind: 'k', content: 'is up',   confidence: 0.9 }),
      entry({ id: 'b', kind: 'k', content: 'is down', confidence: 0.3 }),
    ])
    expect(r[0]!.confidenceDelta).toBeCloseTo(0.6, 2)
  })
})

// ─── detectDuplicates ─────────────────────────────────────────────────

describe('memory-hygiene: detectDuplicates', () => {
  it('groups identical content within the same kind', () => {
    const r = detectDuplicates([
      entry({ id: 'a', kind: 'fact', content: 'X happened', useCount: 5 }),
      entry({ id: 'b', kind: 'fact', content: 'X happened', useCount: 1 }),
      entry({ id: 'c', kind: 'fact', content: 'X happened', useCount: 3 }),
    ])
    expect(r.length).toBe(1)
    expect(r[0]!.keepId).toBe('a')          // highest useCount wins
    expect(r[0]!.dropIds.sort()).toEqual(['b', 'c'])
  })

  it('ignores whitespace + case differences', () => {
    const r = detectDuplicates([
      entry({ id: 'a', content: 'Service X is up' }),
      entry({ id: 'b', content: '  service x is up  ' }),
    ])
    expect(r.length).toBe(1)
    expect(r[0]!.dropIds.length).toBe(1)
  })

  it('different kinds are not duplicates', () => {
    const r = detectDuplicates([
      entry({ id: 'a', kind: 'fact',  content: 'X' }),
      entry({ id: 'b', kind: 'event', content: 'X' }),
    ])
    expect(r.length).toBe(0)
  })

  it('returns empty when no duplicates exist', () => {
    expect(detectDuplicates([entry({ id: 'a', content: 'one' }), entry({ id: 'b', content: 'two' })])).toEqual([])
  })
})
