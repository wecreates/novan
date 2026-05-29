/**
 * simplicity-engine.ts — code + UX complexity scoring (#56).
 *
 * Reads the repository's source files and the platform's route registry
 * to surface clutter that operators (and Novan itself) should consider
 * retiring. Outputs are RECOMMENDATIONS, never auto-applied.
 *
 * Three concerns, each a pure scorer + one DB/FS-backed wrapper:
 *
 *   1. File-level complexity  — line count, function count, cyclomatic
 *      proxy (branches per file), dependency fan-out.
 *   2. Route-surface bloat    — count of routes per prefix, redundant
 *      verb+path duplicates.
 *   3. UI surface bloat       — count of pages, palette entries, app
 *      routes; flags pages that haven't been visited in N days (uses
 *      the `events.type LIKE 'page.view.%'` audit signal when present).
 *
 * All scoring is deterministic and pure-ish — the FS read returns
 * counts only, never raw source. Tests drive the pure scorers with
 * fixtures so behavior stays stable across the repo's own growth.
 *
 * Operational philosophy:
 *   - score, then ask
 *   - never auto-delete code
 *   - never auto-remove UI
 *   - high complexity is a signal to discuss, not an instruction to act
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

// ─── File-level complexity (pure) ───────────────────────────────────────

export interface FileSignal {
  path:             string
  lineCount:        number
  functionCount:    number
  branchCount:      number       // proxy for cyclomatic complexity
  importCount:      number
}

export interface FileComplexity {
  path:             string
  complexityScore:  number       // 0..1
  verdict:          'clean' | 'review' | 'split'
  reasons:          string[]
}

const FILE_THRESHOLDS = {
  longFileLines:    600,
  hugeFileLines:    1200,
  manyFunctions:    20,
  branchesHigh:     60,
  branchesExtreme:  120,
  importsHigh:      25,
}

/** Pure: score a single file's complexity from its signal. */
export function scoreFileComplexity(s: FileSignal): FileComplexity {
  const reasons: string[] = []
  let score = 0
  if (s.lineCount     > FILE_THRESHOLDS.hugeFileLines)   { score += 0.60; reasons.push(`huge-file:${s.lineCount}`) }
  else if (s.lineCount > FILE_THRESHOLDS.longFileLines)  { score += 0.20; reasons.push(`long-file:${s.lineCount}`) }
  if (s.functionCount > FILE_THRESHOLDS.manyFunctions)    { score += 0.15; reasons.push(`many-fns:${s.functionCount}`) }
  if (s.branchCount   > FILE_THRESHOLDS.branchesExtreme)  { score += 0.30; reasons.push(`branchy:${s.branchCount}`) }
  else if (s.branchCount > FILE_THRESHOLDS.branchesHigh)  { score += 0.15; reasons.push(`branchy:${s.branchCount}`) }
  if (s.importCount   > FILE_THRESHOLDS.importsHigh)      { score += 0.10; reasons.push(`fan-in:${s.importCount}`) }
  score = Math.max(0, Math.min(1, score))
  return {
    path: s.path,
    complexityScore: Number(score.toFixed(2)),
    verdict: score >= 0.6 ? 'split' : score >= 0.3 ? 'review' : 'clean',
    reasons,
  }
}

/** Pure: extract signals from a string of source. */
export function signalFromSource(source: string, filePath: string): FileSignal {
  // Strip line + block comments so they don't inflate counts.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const lines = stripped.split(/\r?\n/).filter(l => l.trim().length > 0)
  const functionCount = (stripped.match(/\b(?:function|async function)\s+\w+\s*\(/g) ?? []).length
                      + (stripped.match(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+\w+\s*\(/g) ?? []).length
                      + (stripped.match(/\bconst\s+\w+\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g) ?? []).length
  const branchCount   = (stripped.match(/\b(?:if|else if|switch|case|for|while|catch|\?\s*[^:]+:)\b/g) ?? []).length
                      + (stripped.match(/&&|\|\|/g) ?? []).length
  const importCount   = (stripped.match(/^\s*import\s+[^;\n]+;?\s*$/gm) ?? []).length
                      + (stripped.match(/\bawait\s+import\s*\(/g) ?? []).length
  return { path: filePath, lineCount: lines.length, functionCount, branchCount, importCount }
}

// ─── Route surface (pure) ───────────────────────────────────────────────

export interface RouteSignal {
  method:           'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  fullPath:         string       // e.g. /api/v1/voice/dry-runs/:id/approve
  routeFile:        string
}

export interface RouteSurfaceReport {
  totalRoutes:      number
  byPrefix:         Array<{ prefix: string; count: number }>
  duplicates:       Array<{ method: string; path: string; files: string[] }>
  topHeavyFiles:    Array<{ routeFile: string; routes: number }>
  overweightPrefixes: Array<{ prefix: string; count: number }>   // > 25 routes
}

const PREFIX_HEAVY_THRESHOLD = 25

/** Pure: roll up a route list into a surface-area report. */
export function analyzeRoutes(routes: ReadonlyArray<RouteSignal>): RouteSurfaceReport {
  const byPrefixCount = new Map<string, number>()
  const byMethodPath  = new Map<string, string[]>()
  const byFile        = new Map<string, number>()
  for (const r of routes) {
    const segs = r.fullPath.split('/').filter(Boolean)
    const prefix = segs.slice(0, 3).join('/')                     // /api/v1/<thing>
    byPrefixCount.set(prefix, (byPrefixCount.get(prefix) ?? 0) + 1)
    const key = `${r.method} ${r.fullPath}`
    const arr = byMethodPath.get(key) ?? []
    arr.push(r.routeFile); byMethodPath.set(key, arr)
    byFile.set(r.routeFile, (byFile.get(r.routeFile) ?? 0) + 1)
  }
  return {
    totalRoutes: routes.length,
    byPrefix:    [...byPrefixCount.entries()].sort((a, b) => b[1] - a[1])
                  .map(([prefix, count]) => ({ prefix, count })),
    duplicates:  [...byMethodPath.entries()].filter(([, files]) => files.length > 1)
                  .map(([key, files]) => {
                    const [method, ...rest] = key.split(' ')
                    return { method: method ?? '', path: rest.join(' '), files }
                  }),
    topHeavyFiles: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
                  .map(([routeFile, routes]) => ({ routeFile, routes })),
    overweightPrefixes: [...byPrefixCount.entries()].filter(([, c]) => c > PREFIX_HEAVY_THRESHOLD)
                  .map(([prefix, count]) => ({ prefix, count })),
  }
}

// ─── UI surface (pure) ──────────────────────────────────────────────────

export interface UiSignal {
  pages:           number
  paletteEntries:  number
  appRoutes:       number
  pagesNeverVisited: ReadonlyArray<string>   // optional — empty if no view telemetry
}

export interface UiComplexityReport {
  pageCount:        number
  paletteCount:     number
  routeCount:       number
  staleness:        number      // share of pages that look unused (0..1)
  flags:            string[]
  recommendation:   string
}

export function analyzeUi(s: UiSignal): UiComplexityReport {
  const flags: string[] = []
  const staleness = s.pages === 0 ? 0 : s.pagesNeverVisited.length / s.pages
  if (s.pages          > 80)  flags.push(`page-bloat:${s.pages}`)
  if (s.paletteEntries > 60)  flags.push(`palette-bloat:${s.paletteEntries}`)
  if (s.appRoutes      > 100) flags.push(`route-bloat:${s.appRoutes}`)
  if (staleness        > 0.30) flags.push(`stale-pages:${(staleness * 100).toFixed(0)}%`)
  const recommendation =
      flags.length === 0                    ? 'UI surface looks proportionate.'
    : flags.some(f => f.startsWith('stale')) ? 'Audit unused pages and consider retiring.'
    : 'Consider consolidating sibling pages or grouping under one parent route.'
  return {
    pageCount:    s.pages,
    paletteCount: s.paletteEntries,
    routeCount:   s.appRoutes,
    staleness:    Number(staleness.toFixed(3)),
    flags, recommendation,
  }
}

// ─── FS-backed wrappers (DB-free; reads source tree) ───────────────────

async function listSourceFiles(rootDir: string, extensions: ReadonlyArray<string>): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string) {
    let entries: Array<import('node:fs').Dirent> = []
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const name = String(e.name)
      const p = path.join(d, name)
      if (e.isDirectory()) {
        if (name === 'node_modules' || name === 'dist' || name === '.next' || name === '.turbo') continue
        await walk(p)
      } else if (extensions.some(x => p.endsWith(x))) {
        out.push(p)
      }
    }
  }
  await walk(rootDir)
  return out
}

export interface RepoComplexityReport {
  totalFiles:       number
  byVerdict:        { clean: number; review: number; split: number }
  hottest:          FileComplexity[]   // top 10 by score
  averageScore:     number
}

export async function scanRepoFiles(rootDir: string, opts: { limit?: number } = {}): Promise<RepoComplexityReport> {
  const exts = ['.ts', '.tsx']
  const files = await listSourceFiles(rootDir, exts)
  const verdicts: FileComplexity[] = []
  for (const f of files) {
    let src = ''
    try { src = String(await fs.readFile(f, { encoding: 'utf8' })) } catch { continue }
    if (src.length === 0) continue
    const sig = signalFromSource(src, f)
    verdicts.push(scoreFileComplexity(sig))
  }
  const byVerdict = { clean: 0, review: 0, split: 0 }
  for (const v of verdicts) byVerdict[v.verdict]++
  const avg = verdicts.length === 0 ? 0
    : Number((verdicts.reduce((s, v) => s + v.complexityScore, 0) / verdicts.length).toFixed(3))
  const hottest = [...verdicts].sort((a, b) => b.complexityScore - a.complexityScore).slice(0, opts.limit ?? 10)
  return { totalFiles: verdicts.length, byVerdict, hottest, averageScore: avg }
}
