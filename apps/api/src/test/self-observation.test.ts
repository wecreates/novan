/**
 * Tests for self-observation (#63) — Novan reviewing its own behavior.
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

import { buildSelfReport } from '../services/self-observation.js'

const ev = (type: string, payload: unknown = {}, ageMs = 1000) => ({ type, payload, createdAt: Date.now() - ageMs })
const sk = (kind: string, over: Record<string, unknown> = {}) => ({
  kind, phrase: null, intentKind: null, fromIntent: null, toIntent: null,
  confidence: 0.9, createdAt: Date.now(), ...over,
})

const WIN = 7 * 86_400_000

describe('self-observation: honesty', () => {
  it('flags insufficient data when total is small', () => {
    const r = buildSelfReport([ev('voice.brain.zoom')], [], WIN)
    expect(r.honesty.insufficient).toBe(true)
    expect(r.recommendations[0]!.text.toLowerCase()).toMatch(/tentative|not enough/)
  })

  it('confidence rises with sample size', () => {
    const few = buildSelfReport(Array.from({ length: 10 }, () => ev('x')), [], WIN)
    const many = buildSelfReport(Array.from({ length: 200 }, () => ev('x')), [], WIN)
    expect(many.honesty.confidence).toBeGreaterThan(few.honesty.confidence)
  })

  it('confidence is capped at 1.0', () => {
    const r = buildSelfReport(Array.from({ length: 9999 }, () => ev('x')), [], WIN)
    expect(r.honesty.confidence).toBeLessThanOrEqual(1)
  })

  it('empty input never crashes', () => {
    const r = buildSelfReport([], [], WIN)
    expect(r.totalEvents).toBe(0)
    expect(r.topActions).toEqual([])
  })
})

describe('self-observation: top actions', () => {
  it('counts events by type and ranks descending', () => {
    const r = buildSelfReport([
      ev('voice.brain.zoom'),
      ev('voice.brain.zoom'),
      ev('voice.brain.zoom'),
      ev('voice.summary'),
    ], [], WIN)
    expect(r.topActions[0]).toEqual({ type: 'voice.brain.zoom', count: 3 })
    expect(r.topActions[1]).toEqual({ type: 'voice.summary', count: 1 })
  })

  it('caps top actions at 10 entries', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ev(`type.${i}`))
    const r = buildSelfReport(rows, [], WIN)
    expect(r.topActions.length).toBeLessThanOrEqual(10)
  })
})

describe('self-observation: refusals', () => {
  it('counts plan.verdict==="reject" events', () => {
    const r = buildSelfReport([
      ev('voice.image.generate', { plan: { verdict: 'reject', reason: 'hard-block: purchase' }, intent: { kind: 'image.generate' } }),
      ev('voice.image.generate', { plan: { verdict: 'reject', reason: 'hard-block: purchase' }, intent: { kind: 'image.generate' } }),
      ev('voice.brain.zoom',     { plan: { verdict: 'navigate' }, intent: { kind: 'brain.zoom' } }),
    ], [], WIN)
    const ref = r.refusals.find(x => x.kind === 'image.generate')
    expect(ref?.count).toBe(2)
    expect(ref?.sampleReason).toMatch(/purchase/)
  })

  it('counts events whose type itself signals a block', () => {
    const r = buildSelfReport([
      ev('safety.classifier.hard_block', { reason: 'purchase' }),
      ev('voice.command.rejected', { reason: 'safety' }),
    ], [], WIN)
    expect(r.refusals.length).toBeGreaterThanOrEqual(1)
  })

  it('non-refusal events are excluded', () => {
    const r = buildSelfReport([
      ev('voice.brain.zoom', { plan: { verdict: 'navigate' } }),
    ], [], WIN)
    expect(r.refusals.length).toBe(0)
  })
})

describe('self-observation: operator overrides', () => {
  it('counts corrections per from-intent', () => {
    const r = buildSelfReport([], [
      sk('corrected', { fromIntent: 'brain.focus', toIntent: 'brain.zoom' }),
      sk('corrected', { fromIntent: 'brain.focus', toIntent: 'brain.zoom' }),
      sk('corrected', { fromIntent: 'image.generate', toIntent: 'image.variations' }),
    ], WIN)
    const top = r.operatorOverrides[0]
    expect(top?.kind).toBe('brain.focus')
    expect(top?.count).toBe(2)
  })

  it('ignores corrections without a fromIntent', () => {
    const r = buildSelfReport([], [sk('corrected', { fromIntent: null })], WIN)
    expect(r.operatorOverrides).toEqual([])
  })
})

describe('self-observation: weaknesses + recommendations', () => {
  it('flags an unknown_intent when same phrase misunderstood twice', () => {
    const r = buildSelfReport([], [
      sk('misunderstood', { phrase: 'frobnicate the widget' }),
      sk('misunderstood', { phrase: 'frobnicate the widget' }),
    ], WIN)
    const w = r.weaknesses.find(w => w.category === 'unknown_intent')
    expect(w?.signal).toBe('frobnicate the widget')
    expect(w?.count).toBe(2)
  })

  it('does NOT flag a one-off misunderstood phrase', () => {
    const r = buildSelfReport([], [sk('misunderstood', { phrase: 'once-only' })], WIN)
    expect(r.weaknesses.find(w => w.category === 'unknown_intent')).toBeUndefined()
  })

  it('flags repeated_correction when same fromIntent corrected ≥3 times', () => {
    const r = buildSelfReport([], Array.from({ length: 4 }, () => sk('corrected', { fromIntent: 'brain.focus' })), WIN)
    expect(r.weaknesses.find(w => w.category === 'repeated_correction')).toBeTruthy()
  })

  it('flags low_confidence when 5+ skill observations were below 0.50', () => {
    const r = buildSelfReport([], Array.from({ length: 6 }, () => sk('preferred_action', { confidence: 0.3 })), WIN)
    expect(r.weaknesses.find(w => w.category === 'low_confidence')).toBeTruthy()
  })

  it('produces high-priority recommendation for repeated corrections', () => {
    const r = buildSelfReport(
      // Enough events so we're not insufficient
      Array.from({ length: 30 }, () => ev('voice.brain.zoom')),
      Array.from({ length: 4 }, () => sk('corrected', { fromIntent: 'brain.focus' })),
      WIN,
    )
    expect(r.recommendations.some(rec => rec.priority === 'high')).toBe(true)
  })

  it('never auto-fabricates recommendations when no weaknesses exist', () => {
    const r = buildSelfReport(Array.from({ length: 30 }, () => ev('voice.brain.zoom')), [], WIN)
    expect(r.recommendations.every(rec => rec.priority !== 'high' || rec.text.match(/correction|wrong|review/i))).toBe(true)
  })
})

describe('self-observation: structural invariants', () => {
  it('topActions, refusals, overrides each capped at 10', () => {
    const events = Array.from({ length: 30 }, (_, i) => ev(`t.${i}`, { plan: { verdict: 'reject' }, intent: { kind: `i.${i}` } }))
    const skills = Array.from({ length: 30 }, (_, i) => sk('corrected', { fromIntent: `from.${i}` }))
    const r = buildSelfReport(events, skills, WIN)
    expect(r.topActions.length).toBeLessThanOrEqual(10)
    expect(r.refusals.length).toBeLessThanOrEqual(10)
    expect(r.operatorOverrides.length).toBeLessThanOrEqual(10)
  })

  it('windowMs is echoed back unchanged', () => {
    const r = buildSelfReport([], [], 12345)
    expect(r.windowMs).toBe(12345)
  })
})
