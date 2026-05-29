/**
 * Tests for the three primitives shipped in the third intel-ops turn:
 *   cross-workspace compliance export
 *   predictive forecasting (linear-trend over event buckets)
 *   per-provider concurrency semaphore
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { exportOrg } from '../services/data-governance.js'
import { fitLinear, forecastEventVolume, forecastBreachTime, bucketize } from '../services/predictive-forecast.js'
import { tryAcquire, release, withSlot, setProviderCap, getProviderInflight, snapshotConcurrency, _resetForTests } from '../services/provider-concurrency.js'

// ─── Cross-workspace compliance export ──────────────────────────────────

describe('exportOrg: refusal paths', () => {
  it('refuses without an actor', async () => {
    const r = await exportOrg({ workspaceIds: ['ws-a'], actor: '', reason: 'compliance review' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/actor/)
  })

  it('refuses without a 5+ char reason', async () => {
    const r = await exportOrg({ workspaceIds: ['ws-a'], actor: 'admin', reason: 'no' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/reason/)
  })

  it('refuses on empty workspace list', async () => {
    const r = await exportOrg({ workspaceIds: [], actor: 'admin', reason: 'compliance review' })
    expect(r.ok).toBe(false)
  })

  it('refuses on >50 workspaces', async () => {
    const r = await exportOrg({
      workspaceIds: Array.from({ length: 51 }, (_, i) => `ws-${i}`),
      actor: 'admin', reason: 'compliance review',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/max 50/)
  })

  it('returns a bundle shape on valid input', async () => {
    const r = await exportOrg({ workspaceIds: ['ws-a', 'ws-b'], actor: 'admin', reason: 'compliance review' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.bundle.workspaceIds).toEqual(['ws-a', 'ws-b'])
      expect(r.bundle.aggregate.workspaceCount).toBe(2)
      expect(Object.keys(r.bundle.workspaces).sort()).toEqual(['ws-a', 'ws-b'])
    }
  })
})

// ─── Predictive forecasting ─────────────────────────────────────────────

describe('predictive-forecast: fitLinear', () => {
  it('returns null on fewer than 4 buckets', () => {
    expect(fitLinear([{ t: 0, value: 1 }, { t: 1, value: 2 }, { t: 2, value: 3 }])).toBeNull()
  })

  it('fits a perfect line with R² = 1', () => {
    const b = [{ t: 0, value: 0 }, { t: 1, value: 2 }, { t: 2, value: 4 }, { t: 3, value: 6 }]
    const fit = fitLinear(b)!
    expect(fit.slope).toBeCloseTo(2, 5)
    expect(fit.r2).toBeCloseTo(1, 5)
  })

  it('returns low R² for noisy data', () => {
    const b = [{ t: 0, value: 10 }, { t: 1, value: 1 }, { t: 2, value: 9 }, { t: 3, value: 2 }]
    const fit = fitLinear(b)!
    expect(fit.r2).toBeLessThan(0.5)
  })

  it('returns null when all timestamps are identical', () => {
    expect(fitLinear([{ t: 0, value: 1 }, { t: 0, value: 2 }, { t: 0, value: 3 }, { t: 0, value: 4 }])).toBeNull()
  })
})

describe('predictive-forecast: forecastEventVolume', () => {
  it('rising trend produces a rising forecast', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ t: i * 60_000, value: i * 5 }))
    const f = forecastEventVolume(buckets, 60_000)
    expect(f.trend).toBe('rising')
    expect(f.predictedValue).toBeGreaterThan(buckets[buckets.length - 1]!.value)
  })

  it('falling trend produces a falling forecast', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ t: i * 60_000, value: 100 - i * 5 }))
    const f = forecastEventVolume(buckets, 60_000)
    expect(f.trend).toBe('falling')
  })

  it('flat trend produces a stable forecast', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ t: i * 60_000, value: 50 }))
    const f = forecastEventVolume(buckets, 60_000)
    expect(f.trend).toBe('stable')
  })

  it('weak R² returns insufficient_data, never a fake confident forecast', () => {
    const buckets = [
      { t: 0, value: 10 }, { t: 1, value: 90 }, { t: 2, value: 5 },
      { t: 3, value: 95 }, { t: 4, value: 7 }, { t: 5, value: 88 },
    ]
    const f = forecastEventVolume(buckets, 60_000)
    expect(f.trend).toBe('insufficient_data')
  })

  it('predicted volume never goes negative', () => {
    const buckets = Array.from({ length: 10 }, (_, i) => ({ t: i * 60_000, value: 10 - i }))
    const f = forecastEventVolume(buckets, 600 * 60_000)
    expect(f.predictedValue).toBeGreaterThanOrEqual(0)
  })
})

describe('predictive-forecast: forecastBreachTime', () => {
  it('predicts a breach when the series is climbing toward the threshold', () => {
    const buckets = Array.from({ length: 8 }, (_, i) => ({ t: i * 60_000, value: 10 + i * 5 }))
    const b = forecastBreachTime(buckets, 100)
    expect(b.willBreach).toBe(true)
    expect(b.etaMs).toBeGreaterThan(0)
  })

  it('does not predict a breach when the trend is flat', () => {
    const buckets = Array.from({ length: 8 }, (_, i) => ({ t: i * 60_000, value: 20 }))
    const b = forecastBreachTime(buckets, 100)
    expect(b.willBreach).toBe(false)
  })

  it('reports "already past threshold" when the most recent value exceeds it', () => {
    const buckets = Array.from({ length: 8 }, (_, i) => ({ t: i * 60_000, value: i * 20 }))
    const b = forecastBreachTime(buckets, 50)
    expect(b.willBreach).toBe(true)
    expect(b.etaMs).toBe(0)
  })

  it('returns confidence = R² from the fit', () => {
    const buckets = Array.from({ length: 8 }, (_, i) => ({ t: i * 60_000, value: 10 + i * 2 }))
    const b = forecastBreachTime(buckets, 100)
    expect(b.confidence).toBeGreaterThan(0.9)
  })
})

describe('predictive-forecast: bucketize', () => {
  it('distributes timestamps into the correct bins', () => {
    const start = 0, end = 10
    const ts = [0.5, 1.5, 1.6, 9.5]
    const b = bucketize(ts, start, end, 10)
    expect(b.length).toBe(10)
    expect(b[0]!.value).toBe(1)
    expect(b[1]!.value).toBe(2)
    expect(b[9]!.value).toBe(1)
  })

  it('ignores timestamps outside the window', () => {
    const b = bucketize([-5, 15], 0, 10, 5)
    const total = b.reduce((a, x) => a + x.value, 0)
    expect(total).toBe(0)
  })

  it('returns empty when bucketCount or range is invalid', () => {
    expect(bucketize([1, 2], 10, 5, 4)).toEqual([])
    expect(bucketize([1, 2], 0, 10, 0)).toEqual([])
  })
})

// ─── Provider concurrency ──────────────────────────────────────────────

describe('provider-concurrency: semaphore', () => {
  beforeEach(() => _resetForTests())

  it('default cap allows 4 slots per provider', () => {
    const acquired = [tryAcquire('p1'), tryAcquire('p1'), tryAcquire('p1'), tryAcquire('p1')]
    expect(acquired.every(r => r.ok)).toBe(true)
    const fifth = tryAcquire('p1')
    expect(fifth.ok).toBe(false)
    expect(fifth.reason).toMatch(/saturated/i)
  })

  it('release frees a slot', () => {
    tryAcquire('p1'); tryAcquire('p1'); tryAcquire('p1'); tryAcquire('p1')
    expect(tryAcquire('p1').ok).toBe(false)
    release('p1')
    expect(tryAcquire('p1').ok).toBe(true)
  })

  it('per-provider caps are independent', () => {
    setProviderCap('p1', 1)
    setProviderCap('p2', 1)
    expect(tryAcquire('p1').ok).toBe(true)
    expect(tryAcquire('p1').ok).toBe(false)        // p1 saturated
    expect(tryAcquire('p2').ok).toBe(true)         // p2 still open
  })

  it('total in-flight cap blocks unrelated providers', () => {
    // Default total cap = 16. Burn 16 slots across providers, then expect refusal.
    for (let i = 0; i < 16; i++) tryAcquire(`p${i}`)
    const r = tryAcquire('overflow')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/total/i)
  })

  it('withSlot wraps a job in acquire + release', async () => {
    setProviderCap('p1', 1)
    const r = await withSlot('p1', async () => 42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe(42)
    expect(getProviderInflight('p1')).toBe(0)
  })

  it('withSlot releases even when the job throws', async () => {
    setProviderCap('p1', 1)
    const r = await withSlot('p1', async () => { throw new Error('boom') }).catch(() => ({ ok: false as const, reason: 'caught' }))
    void r
    // counter should be back to 0 either way
    expect(getProviderInflight('p1')).toBe(0)
  })

  it('snapshotConcurrency reports saturated providers', () => {
    setProviderCap('p1', 2)
    tryAcquire('p1'); tryAcquire('p1')
    const snap = snapshotConcurrency()
    const row = snap.find(r => r.provider === 'p1')!
    expect(row.inflight).toBe(2)
    expect(row.saturated).toBe(true)
  })

  it('setProviderCap rejects invalid values', () => {
    setProviderCap('p-bad', -1)
    setProviderCap('p-bad', 0)
    // Defaults should still apply (4)
    const r = tryAcquire('p-bad')
    expect(r.cap).toBe(4)
    release('p-bad')
  })
})
