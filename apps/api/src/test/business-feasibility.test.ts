/**
 * Tests for business-feasibility.ts — the deterministic $10k/mo math.
 *
 * Pure math, no DB, no LLM, no network. Every test here is a property
 * of the unit-economics formulas; any change to the math should
 * trigger an intentional change to these tests.
 */
import { describe, it, expect } from 'vitest'
import { feasibility, FLOOR_USD } from '../services/business-feasibility.js'

describe('business-feasibility: floor constant', () => {
  it('exports the $10k/mo floor at exactly 10_000', () => {
    expect(FLOOR_USD).toBe(10_000)
  })
})

describe('business-feasibility: youtube', () => {
  it('projects revenue with the playbook formula (views × RPM × 0.55 share)', () => {
    const r = feasibility({ category: 'youtube', estRpmUsd: 5, estMonthlyVolume: 1_000_000, channelCount: 1 })
    // 1,000,000 views * $5/1000 * 0.55 = $2,750
    expect(r.monthlyRevenueProjUsd).toBeCloseTo(2_750, 1)
    expect(r.feasible).toBe(false)
    expect(r.gapToFloorUsd).toBeCloseTo(7_250, 1)
  })

  it('marks feasible when projection clears $10k floor', () => {
    // 4M views @ $5 RPM × 0.55 = $11,000 — over floor
    const r = feasibility({ category: 'youtube', estRpmUsd: 5, estMonthlyVolume: 4_000_000, channelCount: 1 })
    expect(r.feasible).toBe(true)
    expect(r.gapToFloorUsd).toBe(0)
    expect(r.pctOfFloor).toBeGreaterThan(1)
  })

  it('caps pctOfFloor at 2.0 even when way over target', () => {
    const r = feasibility({ category: 'youtube', estRpmUsd: 20, estMonthlyVolume: 10_000_000, channelCount: 1 })
    expect(r.pctOfFloor).toBeLessThanOrEqual(2.0)
  })

  it('refuses single-channel sub-5k-view businesses with refusalReason', () => {
    const r = feasibility({ category: 'youtube', estMonthlyVolume: 1_000, channelCount: 1, estRpmUsd: 5 })
    expect(r.refusalReason).toBeTruthy()
    expect(r.refusalReason).toMatch(/portfolio approach/i)
  })

  it('multiplies revenue by channel count', () => {
    const single = feasibility({ category: 'youtube', estRpmUsd: 5, estMonthlyVolume: 200_000, channelCount: 1 })
    const ten    = feasibility({ category: 'youtube', estRpmUsd: 5, estMonthlyVolume: 200_000, channelCount: 10 })
    expect(ten.monthlyRevenueProjUsd).toBeCloseTo(single.monthlyRevenueProjUsd * 10, 1)
  })

  it('provides three closers (views, rpm, channels) for youtube category', () => {
    const r = feasibility({ category: 'youtube' })
    const levers = r.closers.map(c => c.lever)
    expect(levers.length).toBe(3)
    expect(levers.join(',')).toMatch(/views/i)
    expect(levers.join(',')).toMatch(/RPM/i)
    expect(levers.join(',')).toMatch(/channel/i)
  })

  it('identifies a constrained lever as the bottleneck (not "none")', () => {
    const r = feasibility({ category: 'youtube', estRpmUsd: 15, estMonthlyVolume: 10_000, channelCount: 1 })
    // Refusal happens for < 5k views — at 10k views the refusal doesn't fire,
    // so we should see a real bottleneck identified.
    expect(r.bottleneck).not.toBe('(none)')
    expect(r.bottleneck).not.toBe('(uncomputed)')
    // The chosen bottleneck must be one of the actual closer levers.
    const levers = r.closers.map(c => c.lever)
    expect(levers).toContain(r.bottleneck)
  })

  it('uses defaults when inputs are omitted', () => {
    const r = feasibility({ category: 'youtube' })
    expect(r.monthlyRevenueProjUsd).toBeGreaterThan(0)
    expect(r.monthlyRevenueProjUsd).toBeLessThan(FLOOR_USD)
  })
})

describe('business-feasibility: pod', () => {
  it('multiplies units × margin', () => {
    const r = feasibility({ category: 'pod', estMonthlyVolume: 500, marginPerUnitUsd: 10 })
    expect(r.monthlyRevenueProjUsd).toBe(5_000)
    expect(r.feasible).toBe(false)
  })

  it('passes the floor at 1,112+ units × $9 margin (1,111 = $9,999 just under)', () => {
    const r = feasibility({ category: 'pod', estMonthlyVolume: 1_112, marginPerUnitUsd: 9 })
    expect(r.feasible).toBe(true)
    // And just-under stays infeasible
    const r2 = feasibility({ category: 'pod', estMonthlyVolume: 1_111, marginPerUnitUsd: 9 })
    expect(r2.feasible).toBe(false)
  })

  it('refuses POD with margin < $4', () => {
    const r = feasibility({ category: 'pod', marginPerUnitUsd: 3, estMonthlyVolume: 1_000 })
    expect(r.refusalReason).toBeTruthy()
    expect(r.refusalReason).toMatch(/margin/i)
  })

  it('exposes three closers (units, margin, AOV)', () => {
    const r = feasibility({ category: 'pod' })
    expect(r.closers.length).toBe(3)
  })
})

describe('business-feasibility: social', () => {
  it('warns that pure-social rarely hits floor', () => {
    const r = feasibility({ category: 'social' })
    const caveatString = r.caveats.join('\n')
    expect(caveatString).toMatch(/external monetization|rarely hit/i)
  })

  it('refuses low-RPM + low-views as unreachable', () => {
    const r = feasibility({ category: 'social', estRpmUsd: 0.1, estMonthlyVolume: 50_000 })
    expect(r.refusalReason).toBeTruthy()
  })

  it('does not refuse social when volume is huge', () => {
    const r = feasibility({ category: 'social', estRpmUsd: 1, estMonthlyVolume: 15_000_000 })
    expect(r.refusalReason).toBeUndefined()
    expect(r.feasible).toBe(true)
  })
})

describe('business-feasibility: newsletter', () => {
  it('uses ARPU × paying subs', () => {
    const r = feasibility({ category: 'newsletter', estRpmUsd: 10, estMonthlyVolume: 800 })
    expect(r.monthlyRevenueProjUsd).toBe(8_000)
    expect(r.feasible).toBe(false)
  })

  it('feasible at 1,250+ subs × $8 ARPU', () => {
    const r = feasibility({ category: 'newsletter', estRpmUsd: 8, estMonthlyVolume: 1_250 })
    expect(r.feasible).toBe(true)
  })
})

describe('business-feasibility: saas', () => {
  it('treats estMonthlyVolume as MRR directly', () => {
    const r = feasibility({ category: 'saas', estMonthlyVolume: 12_000 })
    expect(r.monthlyRevenueProjUsd).toBe(12_000)
    expect(r.feasible).toBe(true)
  })

  it('warns saas reach requires customer-dev conversations', () => {
    const r = feasibility({ category: 'saas' })
    expect(r.caveats.join('\n')).toMatch(/customer.development|customer-development/i)
  })
})

describe('business-feasibility: caveats', () => {
  it('always includes the $10k floor caveat', () => {
    for (const cat of ['youtube', 'pod', 'social', 'newsletter', 'saas', 'mixed'] as const) {
      const r = feasibility({ category: cat })
      expect(r.caveats.some(c => c.includes('10000') || c.includes('$10'))).toBe(true)
    }
  })

  it('always includes the working-capital warning', () => {
    const r = feasibility({ category: 'youtube' })
    expect(r.caveats.some(c => c.toLowerCase().includes('working capital'))).toBe(true)
  })
})

describe('business-feasibility: closer estMonths plausibility', () => {
  it('reports 0 months when already at/over a lever\'s target', () => {
    const r = feasibility({ category: 'youtube', estRpmUsd: 100, estMonthlyVolume: 1_000_000, channelCount: 1 })
    // RPM 100 is way over target — that closer should report 0 months
    const rpmCloser = r.closers.find(c => /RPM/i.test(c.lever))
    expect(rpmCloser?.estMonthsToDeliver).toBe(0)
  })

  it('reports positive months for under-target levers', () => {
    const r = feasibility({ category: 'youtube', estRpmUsd: 2, estMonthlyVolume: 10_000, channelCount: 1 })
    const viewCloser = r.closers.find(c => /views/i.test(c.lever))
    expect(viewCloser?.estMonthsToDeliver).toBeGreaterThan(0)
  })
})
