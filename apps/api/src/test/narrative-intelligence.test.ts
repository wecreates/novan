/**
 * Tests for narrative-intelligence (#48) — plain-English summaries.
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

import { buildNarrative } from '../services/narrative-intelligence.js'

const ev = (type: string, payload: unknown = {}, t = Date.now()) => ({ type, payload, createdAt: t })

describe('narrative-intelligence: empty + small windows', () => {
  it('empty window produces a calm "nothing happened" headline', () => {
    const n = buildNarrative([], { windowMs: 60 * 60_000 })
    expect(n.headline.toLowerCase()).toMatch(/quiet|nothing/)
    expect(n.paragraphs).toEqual([])
    expect(n.confidence).toBe(1)
  })

  it('single-event window produces a single paragraph and singular grammar', () => {
    const n = buildNarrative([ev('voice.brain.zoom', { intent: { kind: 'brain.zoom' }, plan: { verdict: 'navigate' } })], { windowMs: 60 * 60_000 })
    expect(n.eventCount).toBe(1)
    expect(n.headline).not.toMatch(/events/)        // singular
  })

  it('respects an explicit topic in the empty headline', () => {
    const n = buildNarrative([], { windowMs: 60 * 60_000, topic: 'voice' })
    expect(n.headline.toLowerCase()).toContain('voice')
  })
})

describe('narrative-intelligence: role prioritization', () => {
  it('safety events dominate the headline even when execution is more frequent', () => {
    const rows = [
      ev('voice.dry_run.executed'),
      ev('voice.dry_run.executed'),
      ev('voice.dry_run.executed'),
      ev('voice.safety.block', { plan: { verdict: 'reject' } }),
    ]
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    expect(n.headline.toLowerCase()).toMatch(/block/)
  })

  it('execution headline when only execution events exist', () => {
    const rows = [ev('voice.dry_run.executed'), ev('voice.dry_run.executed')]
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    expect(n.headline.toLowerCase()).toMatch(/executed/)
  })

  it('paragraphs follow the canonical section order', () => {
    const rows = [
      ev('voice.safety.block'),
      ev('voice.dry_run.approval', { source: 'ui' }),
      ev('voice.dry_run.executed'),
    ]
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    const headings = n.paragraphs.map(p => p.heading.toLowerCase())
    const blockIdx = headings.findIndex(h => h.includes('blocked'))
    const approveIdx = headings.findIndex(h => h.includes('approval'))
    const ranIdx = headings.findIndex(h => h.includes('ran'))
    expect(blockIdx).toBeLessThan(approveIdx)
    expect(approveIdx).toBeLessThan(ranIdx)
  })
})

describe('narrative-intelligence: bullets + confidence', () => {
  it('bullets include event count + blocked + approvals + executed counts', () => {
    const rows = [
      ev('voice.safety.block'),
      ev('voice.dry_run.approval', { source: 'ui' }),
      ev('voice.dry_run.executed'),
      ev('voice.dry_run.executed'),
    ]
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    const bulletMap = Object.fromEntries(n.bullets.map(b => [b.label, b.value]))
    expect(bulletMap['events']).toBe('4')
    expect(bulletMap['blocked']).toBe('1')
    expect(bulletMap['approvals']).toBe('1')
    expect(bulletMap['executed']).toBe('2')
  })

  it('most-frequent type is included when present', () => {
    const rows = Array.from({ length: 5 }, () => ev('voice.brain.zoom'))
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    const labels = n.bullets.map(b => b.label)
    expect(labels).toContain('most-frequent')
  })

  it('confidence climbs with sample size and concentration', () => {
    const lowSample = buildNarrative([ev('voice.brain.zoom')], { windowMs: 60 * 60_000 })
    const highSample = buildNarrative(Array.from({ length: 30 }, () => ev('voice.brain.zoom')), { windowMs: 60 * 60_000 })
    expect(highSample.confidence).toBeGreaterThan(lowSample.confidence)
  })

  it('confidence drops when events are spread across many types', () => {
    const concentrated = buildNarrative(Array.from({ length: 20 }, () => ev('voice.brain.zoom')), { windowMs: 60 * 60_000 })
    const scattered = buildNarrative(Array.from({ length: 20 }, (_, i) => ev(`type.${i}`)), { windowMs: 60 * 60_000 })
    expect(scattered.confidence).toBeLessThan(concentrated.confidence)
  })
})

describe('narrative-intelligence: humanization', () => {
  it('uses minutes for sub-hour windows', () => {
    const n = buildNarrative([ev('voice.brain.zoom')], { windowMs: 15 * 60_000 })
    expect(n.headline.toLowerCase()).toContain('min')
  })

  it('uses hours for ≥1h windows', () => {
    const n = buildNarrative([ev('voice.brain.zoom')], { windowMs: 4 * 60 * 60_000 })
    expect(n.headline.toLowerCase()).toContain('hour')
  })

  it('uses days for ≥24h windows', () => {
    const n = buildNarrative([ev('voice.brain.zoom')], { windowMs: 3 * 86_400_000 })
    expect(n.headline.toLowerCase()).toContain('day')
  })
})

describe('narrative-intelligence: caps + safety', () => {
  it('never produces more than 4 paragraphs', () => {
    const rows = [
      ev('voice.safety.block'),
      ev('voice.dry_run.approval'),
      ev('voice.dry_run.executed'),
      ev('voice.brain.zoom'),
      ev('budget.cap_reached'),
    ]
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    expect(n.paragraphs.length).toBeLessThanOrEqual(4)
  })

  it('caps per-section item lines at 5 with a "+N more" suffix', () => {
    const rows = Array.from({ length: 8 }, () => ev('voice.safety.block'))
    const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
    const body = n.paragraphs.find(p => p.heading.toLowerCase().includes('blocked'))!.body
    expect(body).toMatch(/\+3 more/)
  })

  it('never returns negative or NaN confidence', () => {
    for (const count of [0, 1, 5, 50]) {
      const rows = Array.from({ length: count }, () => ev('x'))
      const n = buildNarrative(rows, { windowMs: 60 * 60_000 })
      expect(n.confidence).toBeGreaterThanOrEqual(0)
      expect(n.confidence).toBeLessThanOrEqual(1)
      expect(Number.isNaN(n.confidence)).toBe(false)
    }
  })
})
