/**
 * Tests for business-construction.ts — pure planner.
 * DB-bound `constructBusiness` exercised separately via integration.
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

import { planBusiness, chooseName } from '../services/business-construction.js'

// ─── chooseName ────────────────────────────────────────────────────────

describe('business-construction: chooseName', () => {
  it('extracts a noun phrase from a "build a … business" brief', () => {
    expect(chooseName('build a print on demand clothing business')).toMatch(/Print On Demand Clothing/i)
  })
  it('falls back to "New Business" on empty input', () => {
    expect(chooseName('')).toBe('New Business')
  })
  it('handles "launch X startup" framing', () => {
    expect(chooseName('launch a calm productivity startup')).toMatch(/Calm Productivity/i)
  })
  it('caps absurd brief lengths', () => {
    const n = chooseName('build a ' + 'really '.repeat(50) + 'big business')
    expect(n.length).toBeLessThanOrEqual(60 + 4)
  })
})

// ─── planBusiness archetype selection ──────────────────────────────────

describe('business-construction: planBusiness — archetype selection', () => {
  it('matches print-on-demand brief', () => {
    const p = planBusiness('Build a print on demand t-shirt business for runners.')
    expect(p.systems.some(s => s.name === 'Design Studio')).toBe(true)
    expect(p.systems.some(s => s.name === 'Trend Research')).toBe(true)
    expect(p.systems.some(s => s.name === 'Fulfillment Sync')).toBe(true)
  })

  it('matches SaaS brief', () => {
    const p = planBusiness('Build a B2B SaaS for invoice automation.')
    expect(p.systems.some(s => s.name === 'Product Engineering')).toBe(true)
    expect(p.systems.some(s => s.name === 'Activation Funnel')).toBe(true)
  })

  it('matches newsletter brief', () => {
    const p = planBusiness('I want to launch a newsletter about ai infrastructure.')
    expect(p.systems.some(s => s.name === 'Editorial Calendar')).toBe(true)
    expect(p.systems.some(s => s.name === 'Subscriber Growth')).toBe(true)
  })

  it('matches agency brief', () => {
    const p = planBusiness('Spin up a design agency for fintech startups.')
    expect(p.systems.some(s => s.name === 'Outbound')).toBe(true)
    expect(p.systems.some(s => s.name === 'Delivery Templates')).toBe(true)
  })

  it('falls back to generic for unknown briefs', () => {
    const p = planBusiness('Make me something cool I do not know yet.')
    expect(p.systems.some(s => s.name === 'Operations Cadence')).toBe(true)
    expect(p.systems.some(s => s.name === 'Runway Tracking')).toBe(true)
  })
})

// ─── Structural invariants ─────────────────────────────────────────────

describe('business-construction: plan structure', () => {
  const plan = planBusiness('build a print on demand store')

  it('produces the 7 common departments', () => {
    const depts = plan.systems.filter(s => s.kind === 'department').map(d => d.name).sort()
    expect(depts).toEqual(['Creative', 'Executive', 'Finance', 'Growth', 'Intelligence', 'Operations', 'Security'])
  })

  it('every non-department system has a parent that exists as a department', () => {
    const deptNames = new Set(plan.systems.filter(s => s.kind === 'department').map(d => d.name))
    for (const s of plan.systems) {
      if (s.kind === 'department') continue
      expect(s.parent).toBeDefined()
      expect(deptNames.has(s.parent!)).toBe(true)
    }
  })

  it('DNA carries mission + audience + monetization + brand', () => {
    expect(plan.dna.mission.length).toBeGreaterThan(20)
    expect(plan.dna.audience.length).toBeGreaterThan(10)
    expect(plan.dna.monetization.length).toBeGreaterThan(10)
    expect(plan.dna.brand.palette.length).toBeGreaterThan(0)
  })

  it('agent_slug, when present, points at a real agency catalog slug pattern', () => {
    const slugs = plan.systems.map(s => s.agentSlug).filter(Boolean) as string[]
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z]+-[a-z0-9-]+$/)   // department-rest pattern
    }
    expect(slugs.length).toBeGreaterThan(0)         // at least some workflows have agents wired
  })

  it('every system has a position hint inside the brain canvas space', () => {
    const positioned = plan.systems.filter(s => s.position !== undefined)
    expect(positioned.length).toBeGreaterThan(0)
    for (const s of positioned) {
      expect(Math.abs(s.position!.x)).toBeLessThanOrEqual(10)
      expect(Math.abs(s.position!.y)).toBeLessThanOrEqual(10)
    }
  })
})

// ─── Honest scope guard ────────────────────────────────────────────────

describe('business-construction: honest-scope guard', () => {
  it('never claims execution or deployment in the plan output', () => {
    const plan = planBusiness('build a saas')
    const blob = JSON.stringify(plan).toLowerCase()
    // The plan must describe systems, not pretend they're running.
    expect(blob).not.toContain('deployed')
    expect(blob).not.toContain('shipped to production')
    expect(blob).not.toContain('live in production')
  })

  it('mission language is concrete (no marketing slop)', () => {
    const plan = planBusiness('build a saas')
    const slopWords = ['revolutionary', 'world-class', '10x', 'next-gen', 'cutting-edge', 'disrupt']
    const mission = plan.dna.mission.toLowerCase()
    for (const w of slopWords) {
      expect(mission).not.toContain(w)
    }
  })
})
