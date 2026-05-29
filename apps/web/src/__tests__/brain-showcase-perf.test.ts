/**
 * brain-showcase-perf.test.ts — Tests for the round-127 perf + record
 * additions.
 */
import { describe, it, expect } from 'vitest'
import { dedupeEdges } from '../components/brain-showcase/layouts'
import { extFromMime, pickSupportedMime } from '../components/brain-showcase/recordCanvas'

describe('dedupeEdges', () => {
  it('merges identical from→to pairs, summing weight', () => {
    const out = dedupeEdges([
      { from: 'a', to: 'b', weight: 0.4 },
      { from: 'a', to: 'b', weight: 0.3 },
      { from: 'a', to: 'b', weight: 0.1 },
    ])
    expect(out.length).toBe(1)
    expect(out[0]!.weight).toBeCloseTo(0.8, 4)
  })
  it('preserves direction (a→b vs b→a are distinct)', () => {
    const out = dedupeEdges([
      { from: 'a', to: 'b', weight: 0.5 },
      { from: 'b', to: 'a', weight: 0.5 },
    ])
    expect(out.length).toBe(2)
  })
  it('drops self-loops + missing endpoints', () => {
    const out = dedupeEdges([
      { from: 'a', to: 'a', weight: 1 },
      { from: '',  to: 'b', weight: 1 },
      { from: 'a', to: '',  weight: 1 },
      { from: 'a', to: 'b', weight: 1 },
    ])
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ from: 'a', to: 'b', weight: 1 })
  })
  it('caps to top N by weight desc', () => {
    const raw = Array.from({ length: 500 }, (_, i) => ({
      from: `n${i}`, to: `n${(i + 1) % 500}`, weight: i / 500,
    }))
    const out = dedupeEdges(raw, 50)
    expect(out.length).toBe(50)
    // First item should be the heaviest (weight closest to 1)
    expect(out[0]!.weight).toBeGreaterThan(out[49]!.weight)
  })
  it('handles default weight of 0.2 when missing', () => {
    const out = dedupeEdges([{ from: 'a', to: 'b' }])
    expect(out[0]!.weight).toBeCloseTo(0.2, 4)
  })
  it('returns empty for empty input', () => {
    expect(dedupeEdges([])).toEqual([])
  })
})

describe('recordCanvas helpers', () => {
  it('extFromMime distinguishes mp4 and webm', () => {
    expect(extFromMime('video/mp4; codecs="avc1.42E01E"')).toBe('mp4')
    expect(extFromMime('video/webm; codecs=vp9')).toBe('webm')
    expect(extFromMime('video/webm')).toBe('webm')
  })
  it('pickSupportedMime returns null when MediaRecorder is unavailable', () => {
    // jsdom doesn't ship MediaRecorder. Confirms the function is
    // defensive — production browsers return a real mime.
    const ok = typeof MediaRecorder !== 'undefined'
    const m = pickSupportedMime()
    if (ok) expect(m === null || typeof m === 'string').toBe(true)
    else    expect(m).toBeNull()
  })
})
