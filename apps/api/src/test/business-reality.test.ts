/**
 * Tests for business-reality.ts pace classifier and sunset thresholds.
 *
 * We mock statusFor() + the DB read of `businesses` so the classifier
 * is exercised across all five paces (over-target, on-pace, drifting,
 * structurally-off, no-data) without needing a live database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockStatus: {
  last30DaysUsd: number
  last7DaysUsd:  number
  monthlyTargetUsd: number
  trajectoryUsd: number
  enabled: boolean
  phase: string
} = {
  last30DaysUsd: 0, last7DaysUsd: 0, monthlyTargetUsd: 10_000,
  trajectoryUsd: 0, enabled: true, phase: 'warm-up',
}
let mockBusinessCreatedAt = Date.now() - 30 * 86_400_000   // default 30 days old

vi.mock('../services/business-portfolio.js', () => ({
  statusFor: vi.fn(async (_ws: string, businessId: string) => ({
    id: businessId, name: 'Test Biz', category: 'youtube', enabled: mockStatus.enabled,
    monthlyTargetUsd: mockStatus.monthlyTargetUsd,
    currentMonth: '2026-05',
    currentMonthUsd: mockStatus.last30DaysUsd,
    last30DaysUsd: mockStatus.last30DaysUsd,
    last7DaysUsd:  mockStatus.last7DaysUsd,
    runRateUsd:    mockStatus.last30DaysUsd,
    targetGapUsd:  Math.max(0, mockStatus.monthlyTargetUsd - mockStatus.last30DaysUsd),
    targetPct:     Math.min(2, mockStatus.last30DaysUsd / mockStatus.monthlyTargetUsd),
    trajectoryUsd: mockStatus.trajectoryUsd,
    phase: mockStatus.phase,
    needsAttention: mockStatus.last30DaysUsd < mockStatus.monthlyTargetUsd && mockStatus.trajectoryUsd < mockStatus.monthlyTargetUsd,
    reasons: [],
  })),
}))

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve([{
          id: 'biz-1', workspaceId: 'ws-1', name: 'Test Biz', industry: 'youtube',
          health: 'green', metrics: {}, metadata: {}, dna: {},
          vision: null, brief: null, domain: null, stage: 'early',
          createdAt: mockBusinessCreatedAt,
          updatedAt: Date.now(),
        }]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import { realityCheck, sunsetProposal } from '../services/business-reality.js'

beforeEach(() => {
  mockStatus.last30DaysUsd    = 0
  mockStatus.last7DaysUsd     = 0
  mockStatus.monthlyTargetUsd = 10_000
  mockStatus.trajectoryUsd    = 0
  mockStatus.enabled          = true
  mockStatus.phase            = 'warm-up'
  mockBusinessCreatedAt       = Date.now() - 30 * 86_400_000
})

// ─── pace classifier ─────────────────────────────────────────────────────

describe('realityCheck: pace classifier', () => {
  it('returns "no-data" when < 14 days since launch', async () => {
    mockBusinessCreatedAt = Date.now() - 10 * 86_400_000
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('no-data')
    expect(r!.recommendedAction).toBe('continue')
  })

  it('classifies over-target when last30 ≥ floor', async () => {
    mockStatus.last30DaysUsd = 12_000
    mockStatus.trajectoryUsd = 12_500
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('over-target')
    expect(r!.recommendedAction).toBe('raise-target')
    expect(r!.monthsToFloor).toBe(0)
  })

  it('classifies on-pace when last30 ≥ 75% of floor', async () => {
    mockStatus.last30DaysUsd = 8_000
    mockStatus.last7DaysUsd  = 2_500
    mockStatus.trajectoryUsd = 10_700
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('on-pace')
    expect(r!.recommendedAction).toBe('continue')
  })

  it('classifies on-pace when trajectory ≥ floor even if last30 < 75%', async () => {
    mockStatus.last30DaysUsd = 5_000
    mockStatus.last7DaysUsd  = 2_500
    mockStatus.trajectoryUsd = 10_700
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('on-pace')
  })

  it('classifies drifting in the 30–75% range with traj > 50%', async () => {
    mockStatus.last30DaysUsd = 4_000
    mockStatus.last7DaysUsd  = 1_500
    mockStatus.trajectoryUsd = 6_400
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('drifting')
    expect(r!.recommendedAction).toBe('tweak')
  })

  it('classifies structurally-off when day 90+ AND < 30% of floor', async () => {
    mockBusinessCreatedAt = Date.now() - 100 * 86_400_000
    mockStatus.last30DaysUsd = 500
    mockStatus.last7DaysUsd  = 150
    mockStatus.trajectoryUsd = 650
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('structurally-off')
    expect(r!.recommendedAction).toBe('pivot')
    expect(r!.monthsToFloor).toBe(null)
  })

  it('recommends sunset (not pivot) past day 120 when structurally-off', async () => {
    mockBusinessCreatedAt = Date.now() - 130 * 86_400_000
    mockStatus.last30DaysUsd = 800
    mockStatus.last7DaysUsd  = 200
    mockStatus.trajectoryUsd = 900
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('structurally-off')
    expect(r!.recommendedAction).toBe('sunset')
  })

  it('drifting early-stage (day 14–89) stays "continue"', async () => {
    mockBusinessCreatedAt = Date.now() - 50 * 86_400_000
    mockStatus.last30DaysUsd = 200
    mockStatus.last7DaysUsd  = 50
    mockStatus.trajectoryUsd = 215
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.pace).toBe('drifting')
    expect(r!.recommendedAction).toBe('continue')
  })
})

// ─── honest caveats ──────────────────────────────────────────────────────

describe('realityCheck: honest caveats', () => {
  it('includes the $10k floor reminder in every caveat list', async () => {
    mockStatus.last30DaysUsd = 5_000
    mockStatus.trajectoryUsd = 6_000
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.honestCaveats.some(c => c.includes('$10') || c.includes('10000'))).toBe(true)
  })

  it('adds the operator-decision caveat for structurally-off classification', async () => {
    mockBusinessCreatedAt = Date.now() - 110 * 86_400_000
    mockStatus.last30DaysUsd = 400
    mockStatus.last7DaysUsd  = 100
    mockStatus.trajectoryUsd = 430
    const r = await realityCheck('ws-1', 'biz-1')
    expect(r!.honestCaveats.some(c => /pivot|sunset|structurally/i.test(c))).toBe(true)
  })
})

// ─── sunset proposal ─────────────────────────────────────────────────────

describe('sunsetProposal: day-marker logic', () => {
  it('refuses sunset before day 30', async () => {
    mockBusinessCreatedAt = Date.now() - 20 * 86_400_000
    const r = await sunsetProposal('ws-1', 'biz-1')
    expect(r!.shouldSunset).toBe(false)
    expect(r!.reasons.join(' ')).toMatch(/too early/i)
  })

  it('proposes format pivot at day 30 marker when drifting', async () => {
    mockBusinessCreatedAt = Date.now() - 45 * 86_400_000
    mockStatus.last30DaysUsd = 1_000
    mockStatus.trajectoryUsd = 5_500
    const r = await sunsetProposal('ws-1', 'biz-1')
    expect(r!.shouldSunset).toBe(false)
    expect(r!.alternatives.some(a => a.action === 'pivot-format')).toBe(true)
  })

  it('proposes niche pivot at day 60 marker when still drifting', async () => {
    mockBusinessCreatedAt = Date.now() - 75 * 86_400_000
    mockStatus.last30DaysUsd = 1_500
    mockStatus.trajectoryUsd = 5_500
    const r = await sunsetProposal('ws-1', 'biz-1')
    expect(r!.shouldSunset).toBe(false)
    expect(r!.alternatives.some(a => a.action === 'pivot-niche')).toBe(true)
  })

  it('proposes sunset at day 90+ when structurally-off', async () => {
    mockBusinessCreatedAt = Date.now() - 100 * 86_400_000
    mockStatus.last30DaysUsd = 500
    mockStatus.last7DaysUsd  = 100
    mockStatus.trajectoryUsd = 580
    const r = await sunsetProposal('ws-1', 'biz-1')
    expect(r!.shouldSunset).toBe(true)
    expect(r!.alternatives.some(a => a.action === 'add-monetization-layer')).toBe(true)
  })

  it('always sets finalDecisionGate to operator (brain never executes)', async () => {
    mockBusinessCreatedAt = Date.now() - 100 * 86_400_000
    mockStatus.last30DaysUsd = 500
    mockStatus.last7DaysUsd  = 100
    mockStatus.trajectoryUsd = 580
    const r = await sunsetProposal('ws-1', 'biz-1')
    expect(r!.finalDecisionGate).toBe('operator')
  })
})
