/**
 * Tests for platform-smoke — pure helpers.
 * Live HTTP path is exercised against the running API (out of scope here).
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

import { classify, detectRegressions, buildProbeList, SMOKE_CATALOG } from '../services/platform-smoke.js'

describe('platform-smoke: classify', () => {
  const slow = 3000
  it('200 within slow threshold → ok', () => {
    expect(classify({ path: '/x', status: 200, ms: 100, bodyExcerpt: '' }, slow)).toBe('ok')
  })
  it('200 above threshold → slow', () => {
    expect(classify({ path: '/x', status: 200, ms: 5000, bodyExcerpt: '' }, slow)).toBe('slow')
  })
  it('204 within threshold → ok', () => {
    expect(classify({ path: '/x', status: 204, ms: 50, bodyExcerpt: '' }, slow)).toBe('ok')
  })
  it('400 → bad_input', () => {
    expect(classify({ path: '/x', status: 400, ms: 10, bodyExcerpt: 'workspace_id required' })).toBe('bad_input')
  })
  it('404 → not_found', () => {
    expect(classify({ path: '/x', status: 404, ms: 10, bodyExcerpt: '' })).toBe('not_found')
  })
  it('500 → server_err', () => {
    expect(classify({ path: '/x', status: 500, ms: 10, bodyExcerpt: 'oops' })).toBe('server_err')
  })
  it('503 → server_err', () => {
    expect(classify({ path: '/x', status: 503, ms: 10, bodyExcerpt: '' })).toBe('server_err')
  })
  it('0 status → unreachable', () => {
    expect(classify({ path: '/x', status: 0, ms: 12000, bodyExcerpt: 'timeout' })).toBe('unreachable')
  })
  it('401 → server_err (caller attention)', () => {
    expect(classify({ path: '/x', status: 401, ms: 10, bodyExcerpt: '' })).toBe('server_err')
  })
})

describe('platform-smoke: detectRegressions', () => {
  it('returns empty when nothing changed', () => {
    const prev = [{ path: '/a', status: 200, ms: 1, bodyExcerpt: '' }]
    const next = [{ path: '/a', status: 200, ms: 2, bodyExcerpt: '' }]
    expect(detectRegressions(prev, next)).toEqual([])
  })

  it('detects ok → fail transitions', () => {
    const prev = [{ path: '/a', status: 200, ms: 1, bodyExcerpt: '' }, { path: '/b', status: 200, ms: 1, bodyExcerpt: '' }]
    const next = [{ path: '/a', status: 500, ms: 1, bodyExcerpt: '' }, { path: '/b', status: 200, ms: 1, bodyExcerpt: '' }]
    const r = detectRegressions(prev, next)
    expect(r).toHaveLength(1)
    expect(r[0]?.path).toBe('/a')
    expect(r[0]?.prevStatus).toBe(200)
    expect(r[0]?.nowStatus).toBe(500)
  })

  it('does NOT flag fail → ok (that\'s recovery, not regression)', () => {
    const prev = [{ path: '/a', status: 500, ms: 1, bodyExcerpt: '' }]
    const next = [{ path: '/a', status: 200, ms: 1, bodyExcerpt: '' }]
    expect(detectRegressions(prev, next)).toEqual([])
  })

  it('ignores paths added or removed between runs', () => {
    const prev = [{ path: '/a', status: 200, ms: 1, bodyExcerpt: '' }]
    const next = [{ path: '/b', status: 500, ms: 1, bodyExcerpt: '' }]
    expect(detectRegressions(prev, next)).toEqual([])
  })

  it('treats 400 as failure for regression purposes (was 200 → now 400 IS bad)', () => {
    const prev = [{ path: '/a', status: 200, ms: 1, bodyExcerpt: '' }]
    const next = [{ path: '/a', status: 400, ms: 1, bodyExcerpt: '' }]
    expect(detectRegressions(prev, next)).toHaveLength(1)
  })
})

describe('platform-smoke: buildProbeList', () => {
  it('substitutes {ws} with the encoded workspace id', () => {
    const list = buildProbeList('ws-abc')
    expect(list.every(p => !p.includes('{ws}'))).toBe(true)
    expect(list.some(p => p.includes('workspace_id=ws-abc'))).toBe(true)
  })

  it('URL-encodes workspace ids containing special chars', () => {
    const list = buildProbeList('ws with space')
    expect(list.some(p => p.includes('workspace_id=ws%20with%20space'))).toBe(true)
  })

  it('returns at least one probe per major surface', () => {
    const list = buildProbeList('default')
    const surfaces = ['/api/v1/brain/', '/api/v1/chat/', '/api/v1/agency/', '/api/v1/intel-ops/']
    for (const s of surfaces) {
      expect(list.some(p => p.includes(s))).toBe(true)
    }
  })

  it('catalog has no placeholders left after substitution', () => {
    const list = buildProbeList('x')
    for (const p of list) {
      expect(p).not.toMatch(/\{\w+\}/)
    }
  })
})

describe('platform-smoke: catalog hygiene', () => {
  it('every catalog path starts with / or http', () => {
    for (const p of SMOKE_CATALOG) {
      expect(p.startsWith('/') || p.startsWith('http')).toBe(true)
    }
  })

  it('no duplicates in the catalog', () => {
    const set = new Set(SMOKE_CATALOG)
    expect(set.size).toBe(SMOKE_CATALOG.length)
  })
})
