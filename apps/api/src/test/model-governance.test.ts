/**
 * Tests for model-governance (#46) — trust scoring + degradation detection.
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

import { scoreProviderTrust, detectDegradation, type ProviderTelemetry, type TrustVerdict } from '../services/model-governance.js'

function tel(over: Partial<ProviderTelemetry> = {}): ProviderTelemetry {
  return {
    provider: 'openai', model: 'gpt-4o',
    samples: 20, successRate: 1.0, avgQuality: 0.8,
    hallucinationFlags: 0, recentErrors: 0,
    avgLatencyMs: 500, costVariance: 0.1,
    ...over,
  }
}

describe('model-governance: scoreProviderTrust', () => {
  it('high-quality, high-success → trusted', () => {
    const v = scoreProviderTrust(tel())
    expect(v.verdict).toBe('trusted')
    expect(v.trustScore).toBeGreaterThan(0.7)
  })

  it('low samples → watching with insufficient-data reason', () => {
    const v = scoreProviderTrust(tel({ samples: 2 }))
    expect(v.verdict).toBe('watching')
    expect(v.reasons[0]).toMatch(/insufficient/)
  })

  it('high hallucination rate → rotate', () => {
    const v = scoreProviderTrust(tel({ hallucinationFlags: 15, samples: 20, avgQuality: 0.3, successRate: 0.5 }))
    expect(v.verdict).toBe('rotate')
    expect(v.reasons).toContain('high-hallucination')
  })

  it('many recent errors push verdict to degrading or worse', () => {
    const v = scoreProviderTrust(tel({ recentErrors: 8, successRate: 0.6 }))
    expect(['degrading', 'rotate', 'watching']).toContain(v.verdict)
    expect(v.reasons.some(r => r.startsWith('recent-errors'))).toBe(true)
  })

  it('slow provider gets a slow reason but stays usable', () => {
    const v = scoreProviderTrust(tel({ avgLatencyMs: 8000 }))
    expect(v.reasons.some(r => r.startsWith('slow'))).toBe(true)
  })

  it('trustScore stays in [0,1]', () => {
    const high = scoreProviderTrust(tel({ successRate: 2, avgQuality: 2 }))
    expect(high.trustScore).toBeLessThanOrEqual(1)
    const low  = scoreProviderTrust(tel({ successRate: 0, avgQuality: 0, hallucinationFlags: 50, samples: 20 }))
    expect(low.trustScore).toBeGreaterThanOrEqual(0)
  })

  it('hallucinationRate computed against samples', () => {
    const v = scoreProviderTrust(tel({ samples: 20, hallucinationFlags: 4 }))
    expect(v.hallucinationRate).toBeCloseTo(0.2, 2)
  })
})

describe('model-governance: detectDegradation', () => {
  const v = (provider: string, score: number): TrustVerdict => ({
    provider, model: null, trustScore: score, hallucinationRate: 0,
    verdict: score > 0.7 ? 'trusted' : score > 0.5 ? 'watching' : 'degrading',
    reasons: [], samples: 20,
  })

  it('flags a provider that dropped >10 points', () => {
    const r = detectDegradation([v('openai', 0.5)], [v('openai', 0.9)])
    expect(r.length).toBe(1)
    expect(r[0]!.provider).toBe('openai')
    expect(r[0]!.delta).toBeLessThan(0)
  })

  it('does not flag a small drop', () => {
    const r = detectDegradation([v('openai', 0.85)], [v('openai', 0.9)])
    expect(r.length).toBe(0)
  })

  it('does not flag a provider that improved', () => {
    const r = detectDegradation([v('openai', 0.95)], [v('openai', 0.5)])
    expect(r.length).toBe(0)
  })

  it('orders by largest drop first', () => {
    const now   = [v('a', 0.3), v('b', 0.5)]
    const prior = [v('a', 0.9), v('b', 0.9)]
    const r = detectDegradation(now, prior)
    expect(r[0]!.provider).toBe('a')
    expect(r[1]!.provider).toBe('b')
  })

  it('ignores providers absent from the prior window', () => {
    const r = detectDegradation([v('new', 0.3)], [v('openai', 0.9)])
    expect(r.length).toBe(0)
  })
})
