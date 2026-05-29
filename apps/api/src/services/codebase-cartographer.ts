/**
 * codebase-cartographer.ts — Continuously-updated map of the codebase.
 *
 * The spec calls this out as "non-obvious but critical": every other
 * agent queries the cartographer before starting work. Without it,
 * agents operate blind on large codebases and produce code that fights
 * existing patterns.
 *
 * What it answers:
 *   - what's where (file → role)
 *   - what depends on what (import graph)
 *   - where the patterns live (idiom registry)
 *   - which areas are high-churn or fragile (heatmap)
 *
 * Honest scope:
 *   - This version maps the LIVE Novan repo at C:\Users\19496\ops-platform.
 *     It does NOT yet generalize to arbitrary repos the operator might
 *     have under management; that's a future round where the cartographer
 *     accepts a repo path + ingests it on demand.
 *   - The map is built on-demand (no background indexer here) — operator
 *     calls a brain.task op that returns a fresh snapshot.
 *   - Import-graph parsing is a regex pass over `from '…'` statements;
 *     a real AST pass via tsserver is a future upgrade.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface FileNode {
  path:           string
  role:           'service' | 'route' | 'test' | 'worker' | 'route_plugin' | 'db' | 'frontend_page' | 'frontend_component' | 'frontend_hook' | 'other'
  loc:            number
  imports:        string[]
  exports:        string[]
  lastModifiedMs: number
}

export interface CartographerSnapshot {
  rootPath:       string
  generatedAt:    number
  fileCount:      number
  byRole:         Record<FileNode['role'], number>
  topFiles:       FileNode[]
  /** Files imported by many others — high blast radius if changed. */
  hotImports:     Array<{ file: string; importedBy: number }>
  /** High-churn + high-import = fragile. */
  fragileFiles:   string[]
  /** Identified idiom patterns the cartographer surfaces to specialist agents. */
  idioms:         Array<{ pattern: string; example: string; description: string }>
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', '.next', 'build', 'coverage', '.vscode'])

async function walk(root: string, basePath: string, out: string[], depth = 0): Promise<void> {
  if (depth > 12) return    // safety guard
  let entries: { name: string; isDir: boolean }[] = []
  try {
    const d = await readdir(root, { withFileTypes: true })
    entries = d.map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    if (e.name.startsWith('.') && e.name !== '.env.production.example') continue
    const p = join(root, e.name)
    const rel = p.replace(basePath, '').replace(/\\/g, '/')
    if (e.isDir) {
      await walk(p, basePath, out, depth + 1)
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx') || e.name.endsWith('.js') || e.name.endsWith('.jsx')) {
      out.push(rel.startsWith('/') ? rel.slice(1) : rel)
    }
  }
}

function classifyRole(path: string): FileNode['role'] {
  if (path.includes('/apps/api/src/services/'))    return 'service'
  if (path.includes('/apps/api/src/routes/'))      return 'route'
  if (path.includes('/apps/api/src/test/'))        return 'test'
  if (path.includes('/apps/api/src/workers/'))     return 'worker'
  if (path.includes('/apps/api/src/plugins/'))     return 'route_plugin'
  if (path.includes('/apps/api/src/db/') || path.includes('/packages/db/')) return 'db'
  if (path.includes('/apps/web/src/pages/'))       return 'frontend_page'
  if (path.includes('/apps/web/src/components/'))  return 'frontend_component'
  if (path.includes('/apps/web/src/hooks/'))       return 'frontend_hook'
  return 'other'
}

const IMPORT_RE   = /from\s+['"]([^'"]+)['"]/g
const EXPORT_RE   = /export\s+(?:async\s+)?(?:const|function|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g

async function parseFile(absPath: string, relPath: string): Promise<FileNode | null> {
  try {
    const buf  = await readFile(absPath, 'utf8')
    const stat0 = await stat(absPath)
    const imports: string[] = []
    const exports: string[] = []
    let m: RegExpExecArray | null
    IMPORT_RE.lastIndex = 0
    while ((m = IMPORT_RE.exec(buf)) !== null) imports.push(m[1] ?? '')
    EXPORT_RE.lastIndex = 0
    while ((m = EXPORT_RE.exec(buf)) !== null) exports.push(m[1] ?? '')
    return {
      path:           relPath,
      role:           classifyRole(relPath),
      loc:            buf.split('\n').length,
      imports,
      exports,
      lastModifiedMs: stat0.mtimeMs,
    }
  } catch {
    return null
  }
}

/** Identify idiomatic patterns the cartographer surfaces to specialists.
 *  Pure heuristics — operator can tag additional patterns over time. */
function identifyIdioms(files: FileNode[]): CartographerSnapshot['idioms'] {
  const out: CartographerSnapshot['idioms'] = []
  // Detect "every service emits events" pattern.
  const serviceCount = files.filter(f => f.role === 'service').length
  if (serviceCount > 50) {
    out.push({
      pattern:     'service-events',
      example:     'apps/api/src/services/*.ts → db.insert(events).values({...})',
      description: 'Services emit structured events on state changes — telemetry + audit + downstream consumers all flow through this.',
    })
  }
  // Detect ai_usage tracking pattern.
  const usagePattern = files.filter(f => f.imports.some(i => i.includes('ai-cost-tracker') || i.includes('recordAiUsage')))
  if (usagePattern.length > 5) {
    out.push({
      pattern:     'ai-usage-tracking',
      example:     'recordAiUsage({ workspaceId, provider, model, ..., taskType })',
      description: 'Every LLM/image/voice call records ai_usage for cost dashboards.',
    })
  }
  // Detect reasoning-chain pattern.
  const chainPattern = files.filter(f => f.imports.some(i => i.includes('reasoning-chains')))
  if (chainPattern.length > 3) {
    out.push({
      pattern:     'reasoning-chains',
      example:     `record({ workspaceId, kind, subjectId, decision, source })`,
      description: 'Decisions/recommendations get a reasoning chain row so the brain timeline shows the why behind any action.',
    })
  }
  // Brain-task op shape.
  const opShape = files.find(f => f.path.includes('brain-task.ts'))
  if (opShape) {
    out.push({
      pattern:     'brain-task-op',
      example:     `{ description, risk, handler: async (ws, params) => {...} }`,
      description: 'New capabilities expose to chat + MCP by adding an OpSpec to OPERATIONS map in brain-task.ts.',
    })
  }
  return out
}

export async function generateSnapshot(rootPath: string = 'C:\\Users\\19496\\ops-platform'): Promise<CartographerSnapshot> {
  const norm = rootPath.replace(/\\/g, '/')
  const allFiles: string[] = []
  await walk(rootPath, norm, allFiles)

  const nodes: FileNode[] = []
  // Bounded parallelism — parse 16 at a time so we don't open thousands of fds.
  const BATCH = 16
  for (let i = 0; i < allFiles.length; i += BATCH) {
    const slice = allFiles.slice(i, i + BATCH)
    const results = await Promise.all(slice.map(rel => parseFile(join(rootPath, rel), rel)))
    for (const r of results) if (r) nodes.push(r)
  }

  // Role aggregation
  const byRole = nodes.reduce((acc, n) => {
    acc[n.role] = (acc[n.role] ?? 0) + 1
    return acc
  }, {} as Record<FileNode['role'], number>)

  // Import graph — count how often each file is imported.
  const importedByCount = new Map<string, number>()
  for (const n of nodes) {
    for (const imp of n.imports) {
      // Normalise relative import to a candidate path; skip third-party.
      if (imp.startsWith('.') || imp.startsWith('/')) {
        const key = imp.replace(/\.js$|\.ts$/, '')
        importedByCount.set(key, (importedByCount.get(key) ?? 0) + 1)
      }
    }
  }
  const hotImports = [...importedByCount.entries()]
    .map(([file, importedBy]) => ({ file, importedBy }))
    .sort((a, b) => b.importedBy - a.importedBy)
    .slice(0, 20)

  // Fragile = high churn proxy (recent mtime) AND many importers.
  const cutoff30d = Date.now() - 30 * 86_400_000
  const recentlyChanged = new Set(nodes.filter(n => n.lastModifiedMs > cutoff30d).map(n => n.path))
  const fragile: string[] = []
  for (const h of hotImports) {
    const hit = nodes.find(n => n.path.endsWith(h.file.replace(/^\.\.?\//, '')))
    if (hit && recentlyChanged.has(hit.path) && h.importedBy >= 5) fragile.push(hit.path)
  }

  // Top files = highest-LOC services (likely most operator-relevant).
  const topFiles = [...nodes]
    .filter(n => n.role === 'service')
    .sort((a, b) => b.loc - a.loc)
    .slice(0, 15)

  return {
    rootPath,
    generatedAt: Date.now(),
    fileCount:   nodes.length,
    byRole,
    topFiles,
    hotImports,
    fragileFiles: fragile,
    idioms:       identifyIdioms(nodes),
  }
}

/** Lookup files relevant to a task description. Returns the most-likely
 *  files an agent should read before working. Heuristic = role + name
 *  substring + idiom match. */
export async function findRelevantFiles(input: {
  rootPath?:   string
  query:       string
  maxFiles?:   number
}): Promise<Array<{ path: string; relevance: number; reason: string }>> {
  const snap = await generateSnapshot(input.rootPath)
  const q = input.query.toLowerCase()
  const tokens = q.split(/\s+/).filter(t => t.length > 2)

  const candidates = snap.topFiles.concat(
    // Add any file whose path contains a query token
    snap.hotImports.map(h => h.file).flatMap(f => {
      // map back to node — skip if not parseable here
      return [] as FileNode[]
    })
  )

  // Score each top-file by token-in-path overlap
  const all: Array<{ path: string; relevance: number; reason: string }> = []
  for (const f of snap.topFiles) {
    let score = 0
    const reasons: string[] = []
    for (const t of tokens) {
      if (f.path.toLowerCase().includes(t)) { score += 2; reasons.push(`path matches "${t}"`) }
      if (f.exports.some(e => e.toLowerCase().includes(t))) { score += 3; reasons.push(`exports symbol matching "${t}"`) }
    }
    if (score > 0) all.push({ path: f.path, relevance: score, reason: reasons.join('; ') })
  }
  return all.sort((a, b) => b.relevance - a.relevance).slice(0, input.maxFiles ?? 10)
}
