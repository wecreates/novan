/**
 * Tests for mission-charter.ts — verifies the operating contract is
 * complete, has stable hash, and every principle has required fields.
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
  return { db: { select: () => chain } }
})

import { CHARTER, CHARTER_HASH } from '../services/mission-charter.js'

describe('mission-charter: structural integrity', () => {
  it('has all 21 principles', () => {
    expect(CHARTER.length).toBe(21)
  })

  it('every principle has a unique id', () => {
    const ids = new Set(CHARTER.map(p => p.id))
    expect(ids.size).toBe(CHARTER.length)
  })

  it('every principle has non-empty statement, requires, invariants', () => {
    for (const p of CHARTER) {
      expect(p.statement.length).toBeGreaterThan(20)
      expect(p.requires.length).toBeGreaterThan(0)
      expect(p.invariants.length).toBeGreaterThan(0)
    }
  })

  it('charter hash is stable + non-trivial', () => {
    expect(CHARTER_HASH).toMatch(/^c[0-9a-f]+$/)
    expect(CHARTER_HASH.length).toBeGreaterThan(5)
  })

  it('covers all required sections from the master directive', () => {
    const sections = new Set(CHARTER.map(p => p.section))
    // The 21 master-directive sections we encoded
    const required = [
      'identity', 'always_on', 'self_improvement', 'capability_builder',
      'divisions', 'cognition', 'executive', 'reality_anchoring', 'learning',
      'compression', 'quality', 'commerce', 'security_ethics', 'governance',
      'fabric', 'creative', 'simulation', 'explainability', 'verification',
      'war_room', 'operator_first',
    ]
    for (const r of required) expect(sections.has(r)).toBe(true)
  })

  it('the highest-priority principles include operator-first and security_ethics', () => {
    // These are non-negotiable; ensure they're in the charter
    expect(CHARTER.find(p => p.section === 'security_ethics')).toBeDefined()
    expect(CHARTER.find(p => p.section === 'operator_first')).toBeDefined()
  })

  it('reality anchoring principle requires the four anchor services', () => {
    const p = CHARTER.find(p => p.section === 'reality_anchoring')!
    for (const svc of ['ground-truth-engine', 'drift-detector', 'reality-correction', 'assumption-tracker']) {
      expect(p.requires).toContain(svc)
    }
  })

  it('commerce principle blocks purchase + IP + spam', () => {
    const p = CHARTER.find(p => p.section === 'commerce')!
    expect(p.statement).toMatch(/Never purchase/i)
    expect(p.statement).toMatch(/IP/i)
    expect(p.statement).toMatch(/spam/i)
  })
})
