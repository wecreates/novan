/**
 * Tests for brain-timeline.ts — decisionPath window clamping + replay contract.
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
vi.mock('../services/brain-persistence.js', () => ({ bulkStatusAt: async () => new Map() }))

import { decisionPath, replayAt, timelineSummary } from '../services/brain-timeline.js'

describe('brain-timeline: decisionPath window clamping', () => {
  it('default window is 5 minutes', async () => {
    const p = await decisionPath('__test__', 'nonexistent-key')
    expect(p.notes.some(n => n.includes('±5min'))).toBe(true)
  })

  it('honors a custom window up to 60 minutes', async () => {
    const p = await decisionPath('__test__', 'nonexistent-key', 30)
    expect(p.notes.some(n => n.includes('±30min'))).toBe(true)
  })

  it('clamps window above 60 to 60', async () => {
    const p = await decisionPath('__test__', 'nonexistent-key', 999)
    // Whether path has steps or not, the window value is clamped — appears in the "no related events" note
    expect(p.notes.some(n => n.includes('±60min') || n.includes('60min'))).toBe(true)
  })

  it('clamps window below 1 to 1', async () => {
    const p = await decisionPath('__test__', 'nonexistent-key', 0)
    expect(p.notes.some(n => n.includes('±1min') || n.includes('1min'))).toBe(true)
  })
})

describe('brain-timeline: replayAt contract', () => {
  it('always returns readOnly: true', async () => {
    const r = await replayAt('__test__', Date.now() - 60_000)
    expect(r.replay.readOnly).toBe(true)
  })

  it('honestNote present', async () => {
    const r = await replayAt('__test__', Date.now() - 60_000)
    expect(typeof r.replay.honestNote).toBe('string')
    expect(r.replay.honestNote.length).toBeGreaterThan(20)
  })

  it('statusReconstructed >= 0', async () => {
    const r = await replayAt('__test__', Date.now() - 60_000)
    expect(r.replay.statusReconstructed).toBeGreaterThanOrEqual(0)
  })
})

describe('brain-timeline: timelineSummary', () => {
  it('returns empty buckets when no events', async () => {
    const r = await timelineSummary('__test__', Date.now() - 3600_000, Date.now(), 60_000)
    expect(Array.isArray(r.buckets)).toBe(true)
    expect(r.totalEvents).toBe(0)
  })

  it('honors bucket size parameter', async () => {
    const r = await timelineSummary('__test__', 0, 1000, 100)
    expect(r.bucketMs).toBe(100)
  })
})
