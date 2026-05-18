/**
 * Tests for identity-core.audit, runtime-fabric.decideScale,
 * simulation-engine.compareDecisions. All pure functions.
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

import { audit } from '../services/identity-core.js'
import { decideScale } from '../services/runtime-fabric.js'
import { compareDecisions } from '../services/simulation-engine.js'

describe('identity-core: audit() hype detection', () => {
  it('flags fake certainty', () => {
    const r = audit('This will absolutely 100% definitely succeed', 'rec')
    expect(r.hypeScore).toBeGreaterThan(0.15)
    expect(r.violations.some(v => v.detail === 'fake certainty')).toBe(true)
  })
  it('flags hype adjectives', () => {
    const r = audit('Amazing release that is revolutionary and game-changing!!', 'brief')
    expect(r.hypeScore).toBeGreaterThan(0)
    // Hype + multiple exclamations push to fail
    expect(r.violations.some(v => v.detail === 'hype adjective')).toBe(true)
  })
  it('flags growth hype', () => {
    const r = audit('Skyrocket 10x explosive growth moonshot', 'rec')
    expect(r.hypeScore).toBeGreaterThan(0.15)
  })
  it('flags multiple exclamations', () => {
    const r = audit('Production ready!!! Ship it now!!!', 'brief')
    expect(r.violations.some(v => v.detail === 'multiple exclamations')).toBe(true)
  })

  it('passes clean professional copy', () => {
    const r = audit('Incident resolved. Provider was degraded for 12 minutes; failover engaged at T+3:14.', 'incident')
    expect(r.hypeScore).toBeLessThan(0.2)
    expect(r.passed).toBe(true)
  })
})

describe('identity-core: audit() uncertainty handling', () => {
  it('flags missing uncertainty in prediction context (rec)', () => {
    const r = audit('Provider Groq will outperform OpenAI by 30% next quarter', 'rec')
    expect(r.uncertaintyHandling).toBe('missing')
    expect(r.passed).toBe(false)
  })
  it('flags missing uncertainty in research context', () => {
    const r = audit('Sales will grow by 50% in Q3', 'research')
    expect(r.uncertaintyHandling).toBe('missing')
    expect(r.passed).toBe(false)
  })
  it('passes explicit uncertainty in prediction context', () => {
    const r = audit('Provider Groq is likely to outperform OpenAI by approximately 30% next quarter (confidence 0.7)', 'rec')
    expect(r.uncertaintyHandling).toBe('explicit')
    expect(r.passed).toBe(true)
  })
})

describe('identity-core: audit() fact/estimate separation', () => {
  it('flags blur when prediction language used without estimate marker', () => {
    const r = audit('Revenue will hit $50k by end of Q4', 'rec')
    expect(r.factEstimateOk).toBe(false)
  })
  it('passes when prediction is clearly marked', () => {
    const r = audit('Revenue forecast: ~$50k by end of Q4 (estimate, conf 0.6)', 'rec')
    expect(r.factEstimateOk).toBe(true)
  })
  it('passes when fact is clearly marked', () => {
    const r = audit('Observed: revenue reached $50k by end of Q4 (verified via stripe events)', 'incident')
    expect(r.factEstimateOk).toBe(true)
  })
})

describe('runtime-fabric: decideScale()', () => {
  it('scales up on high queue + high utilization', () => {
    const d = decideScale('worker', { healthyNodes: 2, totalQueueDepth: 80, avgUtilization: 0.85 })
    expect(d.kind).toBe('scale_up')
    expect(d.after).toBe(3)
  })
  it('scales up by 2 on critical queue', () => {
    const d = decideScale('worker', { healthyNodes: 2, totalQueueDepth: 250, avgUtilization: 0.5 })
    expect(d.kind).toBe('scale_up')
    expect(d.after).toBe(4)
  })
  it('scales down on low load', () => {
    const d = decideScale('worker', { healthyNodes: 3, totalQueueDepth: 0, avgUtilization: 0.1 })
    expect(d.kind).toBe('scale_down')
    expect(d.after).toBe(2)
  })
  it('does NOT scale down to zero', () => {
    const d = decideScale('worker', { healthyNodes: 1, totalQueueDepth: 0, avgUtilization: 0 })
    expect(d.kind).toBe('noop')
  })
  it('respects max replica cap', () => {
    const d = decideScale('worker', { healthyNodes: 8, totalQueueDepth: 500, avgUtilization: 0.95 })
    expect(d.kind).toBe('throttle')
    expect(d.after).toBe(8)
  })
  it('returns noop in steady state', () => {
    const d = decideScale('worker', { healthyNodes: 2, totalQueueDepth: 20, avgUtilization: 0.5 })
    expect(d.kind).toBe('noop')
  })
})

describe('simulation-engine: compareDecisions()', () => {
  it('picks highest-benefit when all else equal', () => {
    const r = compareDecisions([
      { name: 'A', benefit: '', benefitScore: 0.4, risk: '', riskScore: 0.2, costUsd: 10, rollbackComplexity: 'moderate', confidence: 0.7 },
      { name: 'B', benefit: '', benefitScore: 0.8, risk: '', riskScore: 0.2, costUsd: 10, rollbackComplexity: 'moderate', confidence: 0.7 },
    ])
    expect(r.recommended).toBe(1)
  })
  it('penalizes irreversible rollbacks', () => {
    const r = compareDecisions([
      { name: 'safe', benefit: '', benefitScore: 0.6, risk: '', riskScore: 0.2, costUsd: 0, rollbackComplexity: 'trivial', confidence: 0.7 },
      { name: 'risky', benefit: '', benefitScore: 0.8, risk: '', riskScore: 0.2, costUsd: 0, rollbackComplexity: 'irreversible', confidence: 0.7 },
    ])
    expect(r.recommended).toBe(0)
  })
  it('penalizes high risk', () => {
    const r = compareDecisions([
      { name: 'A', benefit: '', benefitScore: 0.5, risk: '', riskScore: 0.0, costUsd: 0, rollbackComplexity: 'moderate', confidence: 0.7 },
      { name: 'B', benefit: '', benefitScore: 0.5, risk: '', riskScore: 0.9, costUsd: 0, rollbackComplexity: 'moderate', confidence: 0.7 },
    ])
    expect(r.recommended).toBe(0)
  })
  it('penalizes low confidence', () => {
    const r = compareDecisions([
      { name: 'A', benefit: '', benefitScore: 0.5, risk: '', riskScore: 0.2, costUsd: 0, rollbackComplexity: 'moderate', confidence: 0.9 },
      { name: 'B', benefit: '', benefitScore: 0.5, risk: '', riskScore: 0.2, costUsd: 0, rollbackComplexity: 'moderate', confidence: 0.3 },
    ])
    expect(r.recommended).toBe(0)
  })
})
