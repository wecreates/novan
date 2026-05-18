/**
 * code-introspection.ts — Self-knowledge: walks the API service surface
 * and reports what the platform actually has.
 *
 * Honest scope: counts files + extracts top-level exports via cheap regex.
 * Does NOT parse the AST — false positives possible if `export` appears in
 * a string. Good enough for a self-status view.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

interface ServiceModule {
  file: string
  bytes: number
  exports: string[]
}

interface IntrospectionResult {
  generatedAt:    number
  repoRoot:       string
  serviceCount:   number
  routeCount:     number
  servicesIndex:  ServiceModule[]
  routesIndex:    ServiceModule[]
  totalExports:   number
  notes:          string[]
}

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/gm

function scanDir(dir: string): ServiceModule[] {
  if (!existsSync(dir)) return []
  const out: ServiceModule[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue
    const file = join(dir, name)
    let s
    try { s = statSync(file); if (!s.isFile()) continue } catch { continue }
    let body
    try { body = readFileSync(file, 'utf8') } catch { continue }
    const exports: string[] = []
    let m
    EXPORT_RE.lastIndex = 0
    while ((m = EXPORT_RE.exec(body)) !== null) exports.push(m[1]!)
    out.push({ file: name, bytes: s.size, exports })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

export function introspectCode(): IntrospectionResult {
  const repoRoot = process.env['REPO_ROOT'] ?? '/app'
  const servicesIndex = scanDir(join(repoRoot, 'apps/api/src/services'))
  const routesIndex   = scanDir(join(repoRoot, 'apps/api/src/routes'))
  const totalExports = servicesIndex.reduce((s, m) => s + m.exports.length, 0)
                     + routesIndex.reduce((s, m) => s + m.exports.length, 0)
  const notes: string[] = []
  if (servicesIndex.length === 0) notes.push(`No services found under ${repoRoot}/apps/api/src/services — REPO_ROOT may be misconfigured.`)
  return {
    generatedAt: Date.now(),
    repoRoot,
    serviceCount: servicesIndex.length,
    routeCount:   routesIndex.length,
    servicesIndex, routesIndex,
    totalExports, notes,
  }
}
