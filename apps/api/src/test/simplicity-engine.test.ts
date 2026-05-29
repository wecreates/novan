/**
 * Tests for the simplicity engine (#56) — pure scorers + analyzers.
 */
import { describe, it, expect } from 'vitest'
import {
  signalFromSource, scoreFileComplexity, analyzeRoutes, analyzeUi,
  type FileSignal, type RouteSignal,
} from '../services/simplicity-engine.js'

// ─── File-level scoring ────────────────────────────────────────────────

describe('simplicity: scoreFileComplexity', () => {
  const base = (over: Partial<FileSignal> = {}): FileSignal => ({
    path: 'x.ts', lineCount: 100, functionCount: 5, branchCount: 10, importCount: 5, ...over,
  })

  it('small clean file → clean verdict, near-zero score', () => {
    const r = scoreFileComplexity(base())
    expect(r.verdict).toBe('clean')
    expect(r.complexityScore).toBeLessThan(0.2)
  })

  it('huge file → split verdict', () => {
    const r = scoreFileComplexity(base({ lineCount: 1500 }))
    expect(r.verdict).toBe('split')
    expect(r.reasons.some(x => x.startsWith('huge-file'))).toBe(true)
  })

  it('long file → review', () => {
    const r = scoreFileComplexity(base({ lineCount: 700 }))
    expect(r.reasons.some(x => x.startsWith('long-file'))).toBe(true)
  })

  it('extreme branchiness contributes 0.30', () => {
    const r = scoreFileComplexity(base({ branchCount: 150 }))
    expect(r.complexityScore).toBeGreaterThanOrEqual(0.3)
    expect(r.reasons.some(x => x.startsWith('branchy'))).toBe(true)
  })

  it('many functions adds a reason', () => {
    const r = scoreFileComplexity(base({ functionCount: 30 }))
    expect(r.reasons.some(x => x.startsWith('many-fns'))).toBe(true)
  })

  it('high import fan-in adds a reason', () => {
    const r = scoreFileComplexity(base({ importCount: 40 }))
    expect(r.reasons.some(x => x.startsWith('fan-in'))).toBe(true)
  })

  it('score is bounded in [0,1]', () => {
    const r = scoreFileComplexity(base({ lineCount: 5000, functionCount: 200, branchCount: 1000, importCount: 200 }))
    expect(r.complexityScore).toBeLessThanOrEqual(1)
    expect(r.complexityScore).toBeGreaterThanOrEqual(0)
  })
})

// ─── Signal extraction from source ─────────────────────────────────────

describe('simplicity: signalFromSource', () => {
  it('counts non-empty lines after stripping comments', () => {
    const src = `// header comment\n/* block */\nconst x = 1\n\nconst y = 2`
    const s = signalFromSource(src, 'a.ts')
    expect(s.lineCount).toBe(2)
  })

  it('counts function declarations + arrow functions', () => {
    const src = `function a() {}\nasync function b() {}\nconst c = () => 1\nexport default function d() {}`
    const s = signalFromSource(src, 'a.ts')
    expect(s.functionCount).toBeGreaterThanOrEqual(3)
  })

  it('counts branch points + boolean operators', () => {
    const src = `if (a) {} else if (b) {} for (;;) {} while (true) {} switch (z) { case 1: } a && b || c ? 1 : 2`
    const s = signalFromSource(src, 'a.ts')
    expect(s.branchCount).toBeGreaterThan(5)
  })

  it('counts imports including dynamic imports', () => {
    const src = `import a from 'a'\nimport { b } from 'b'\nawait import('./c')`
    const s = signalFromSource(src, 'a.ts')
    expect(s.importCount).toBe(3)
  })

  it('returns zeros for an empty file', () => {
    const s = signalFromSource('', 'a.ts')
    expect(s.lineCount).toBe(0)
    expect(s.functionCount).toBe(0)
    expect(s.branchCount).toBe(0)
    expect(s.importCount).toBe(0)
  })
})

// ─── Route analyzer ────────────────────────────────────────────────────

describe('simplicity: analyzeRoutes', () => {
  const route = (over: Partial<RouteSignal> = {}): RouteSignal => ({
    method: 'GET', fullPath: '/api/v1/voice/sessions', routeFile: 'voice.ts', ...over,
  })

  it('groups routes by prefix', () => {
    const r = analyzeRoutes([
      route({ fullPath: '/api/v1/voice/a' }),
      route({ fullPath: '/api/v1/voice/b' }),
      route({ fullPath: '/api/v1/intel-ops/c' }),
    ])
    const voice = r.byPrefix.find(p => p.prefix === 'api/v1/voice')!
    expect(voice.count).toBe(2)
  })

  it('detects exact-duplicate (method, path) across files', () => {
    const r = analyzeRoutes([
      route({ method: 'POST', fullPath: '/x', routeFile: 'a.ts' }),
      route({ method: 'POST', fullPath: '/x', routeFile: 'b.ts' }),
    ])
    expect(r.duplicates.length).toBe(1)
    expect(r.duplicates[0]!.files.sort()).toEqual(['a.ts', 'b.ts'])
  })

  it('flags prefixes over the heavy threshold', () => {
    const routes = Array.from({ length: 30 }, (_, i) => route({ fullPath: `/api/v1/voice/${i}` }))
    const r = analyzeRoutes(routes)
    expect(r.overweightPrefixes.length).toBe(1)
  })

  it('ranks the heaviest route files', () => {
    const routes: RouteSignal[] = [
      ...Array.from({ length: 10 }, (_, i) => route({ fullPath: `/v/${i}`, routeFile: 'voice.ts' })),
      ...Array.from({ length: 3 },  (_, i) => route({ fullPath: `/i/${i}`, routeFile: 'images.ts' })),
    ]
    const r = analyzeRoutes(routes)
    expect(r.topHeavyFiles[0]!.routeFile).toBe('voice.ts')
    expect(r.topHeavyFiles[0]!.routes).toBe(10)
  })

  it('empty input returns zero totals', () => {
    const r = analyzeRoutes([])
    expect(r.totalRoutes).toBe(0)
    expect(r.duplicates).toEqual([])
  })
})

// ─── UI analyzer ───────────────────────────────────────────────────────

describe('simplicity: analyzeUi', () => {
  it('proportionate UI returns no flags', () => {
    const r = analyzeUi({ pages: 30, paletteEntries: 30, appRoutes: 30, pagesNeverVisited: [] })
    expect(r.flags).toEqual([])
    expect(r.recommendation).toMatch(/proportionate/)
  })

  it('flags page bloat', () => {
    const r = analyzeUi({ pages: 120, paletteEntries: 30, appRoutes: 30, pagesNeverVisited: [] })
    expect(r.flags.some(f => f.startsWith('page-bloat'))).toBe(true)
  })

  it('flags palette bloat', () => {
    const r = analyzeUi({ pages: 30, paletteEntries: 80, appRoutes: 30, pagesNeverVisited: [] })
    expect(r.flags.some(f => f.startsWith('palette-bloat'))).toBe(true)
  })

  it('flags route bloat', () => {
    const r = analyzeUi({ pages: 30, paletteEntries: 30, appRoutes: 150, pagesNeverVisited: [] })
    expect(r.flags.some(f => f.startsWith('route-bloat'))).toBe(true)
  })

  it('flags stale-page share and recommends an audit', () => {
    const r = analyzeUi({ pages: 10, paletteEntries: 10, appRoutes: 10, pagesNeverVisited: ['a', 'b', 'c', 'd'] })
    expect(r.flags.some(f => f.startsWith('stale-pages'))).toBe(true)
    expect(r.recommendation).toMatch(/audit/i)
  })

  it('staleness stays in [0,1]', () => {
    const r = analyzeUi({ pages: 10, paletteEntries: 0, appRoutes: 0, pagesNeverVisited: ['a','b','c','d','e','f','g','h','i','j'] })
    expect(r.staleness).toBe(1)
  })

  it('returns 0 staleness when there are no pages', () => {
    const r = analyzeUi({ pages: 0, paletteEntries: 0, appRoutes: 0, pagesNeverVisited: [] })
    expect(r.staleness).toBe(0)
  })
})
