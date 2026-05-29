/**
 * brain-showcase-layouts.test.ts — Pure tests for view-mode positioning
 * + URL state encode/decode.
 */
import { describe, it, expect } from 'vitest'
import {
  layoutGalaxy, layoutHierarchy, layoutActivity, layoutFocus, layoutFor,
  encodeState, decodeState, type ViewMode,
} from '../components/brain-showcase/layouts'

const sampleNodes = [
  { id: 'a1', group: 'biz-acme',  activity: 0.9 },
  { id: 'a2', group: 'biz-acme',  activity: 0.1 },
  { id: 'b1', group: 'biz-other', activity: 0.5 },
  { id: 'c1', group: 'biz-third', activity: 0.0 },
]

describe('layoutGalaxy', () => {
  it('positions every node', () => {
    const m = layoutGalaxy(sampleNodes)
    expect(m.size).toBe(sampleNodes.length)
    for (const n of sampleNodes) expect(m.get(n.id)).toBeDefined()
  })
  it('is deterministic — same input → same positions', () => {
    const a = layoutGalaxy(sampleNodes)
    const b = layoutGalaxy(sampleNodes)
    for (const n of sampleNodes) {
      expect(a.get(n.id)!.pos).toEqual(b.get(n.id)!.pos)
    }
  })
  it('nodes in the same group cluster near each other', () => {
    const m = layoutGalaxy(sampleNodes)
    const acme = sampleNodes.filter(n => n.group === 'biz-acme').map(n => m.get(n.id)!.pos)
    const other = m.get('b1')!.pos
    // Distance within acme should be smaller than from acme to b1.
    const d = (a: [number,number,number], b: [number,number,number]) =>
      Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2])
    expect(d(acme[0]!, acme[1]!)).toBeLessThan(d(acme[0]!, other))
  })
})

describe('layoutHierarchy', () => {
  it('places each group in its own X column with Y descending', () => {
    const m = layoutHierarchy(sampleNodes)
    const a1 = m.get('a1')!.pos
    const a2 = m.get('a2')!.pos
    // Same group → same column (similar X)
    expect(Math.abs(a1[0] - a2[0])).toBeLessThan(2)
    // a1 is root (index 0), a2 hangs below → smaller Y
    expect(a2[1]).toBeLessThan(a1[1])
  })
  it('different groups land in different X columns', () => {
    const m = layoutHierarchy(sampleNodes)
    const a1 = m.get('a1')!.pos
    const b1 = m.get('b1')!.pos
    expect(Math.abs(a1[0] - b1[0])).toBeGreaterThan(2)
  })
})

describe('layoutActivity', () => {
  it('high-activity nodes push forward on Z relative to galaxy baseline', () => {
    const galaxy   = layoutGalaxy(sampleNodes)
    const activity = layoutActivity(sampleNodes)
    const high = activity.get('a1')!.pos   // activity 0.9
    const baseHigh = galaxy.get('a1')!.pos
    expect(high[2]).toBeGreaterThan(baseHigh[2])
  })
  it('low-activity nodes recede with lower emphasis', () => {
    const activity = layoutActivity(sampleNodes)
    const cold = activity.get('c1')!         // activity 0.0
    const hot  = activity.get('a1')!         // activity 0.9
    expect(cold.emphasis).toBeLessThan(hot.emphasis)
  })
})

describe('layoutFocus', () => {
  it('focused group sits near origin; other groups orbit far out', () => {
    const m = layoutFocus(sampleNodes, 'biz-acme')
    const focused = m.get('a1')!.pos
    const peripheral = m.get('b1')!.pos
    const distOrigin = (p: [number,number,number]) => Math.hypot(p[0], p[1], p[2])
    expect(distOrigin(focused)).toBeLessThan(distOrigin(peripheral))
  })
  it('focused emphasis is 1, peripheral emphasis is dim', () => {
    const m = layoutFocus(sampleNodes, 'biz-acme')
    expect(m.get('a1')!.emphasis).toBe(1)
    expect(m.get('b1')!.emphasis).toBeLessThan(0.5)
  })
})

describe('layoutFor — mode router', () => {
  it('routes each mode to its specific layout', () => {
    const modes: ViewMode[] = ['galaxy', 'hierarchy', 'activity']
    for (const mode of modes) {
      const m = layoutFor(mode, sampleNodes)
      expect(m.size).toBe(sampleNodes.length)
    }
  })
  it('focus mode requires focusGroup; falls back to galaxy without it', () => {
    const m = layoutFor('focus', sampleNodes)   // no focusGroup
    const gal = layoutFor('galaxy', sampleNodes)
    expect(m.get('a1')!.pos).toEqual(gal.get('a1')!.pos)
  })
})

describe('encodeState / decodeState', () => {
  it('round-trips the full state', () => {
    const s = { view: 'focus' as ViewMode, focus: 'biz-acme', anon: false, cinema: true }
    const decoded = decodeState(encodeState(s))
    expect(decoded.view).toBe('focus')
    expect(decoded.focus).toBe('biz-acme')
    expect(decoded.anon).toBe(false)
    expect(decoded.cinema).toBe(true)
  })
  it('defaults to galaxy + anon-on + cinema-on for empty input', () => {
    const d = decodeState('')
    expect(d.view).toBe('galaxy')
    expect(d.anon).toBe(true)
    expect(d.cinema).toBe(true)
    expect(d.focus).toBeUndefined()
  })
  it('rejects invalid view value, falls back to galaxy', () => {
    const d = decodeState('view=invalid')
    expect(d.view).toBe('galaxy')
  })
  it('omits focus from encoded URL when not set', () => {
    const enc = encodeState({ view: 'galaxy', anon: true, cinema: true })
    expect(enc).not.toContain('focus=')
  })
})
