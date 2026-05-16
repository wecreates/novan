/**
 * repo-auditor.ts — Full-repo audit runner.
 *
 * Scans real files for:
 *   1. Anti-patterns (fake logic, in-memory stores, hardcoded values, empty catches)
 *   2. Missing test coverage per service
 *   3. Frontend links that have no Route definition
 *
 * Every finding references a real file + line number.
 * Every build task traces back to a finding.
 * No fake results generated.
 */
import { readFile, readdir }   from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { eq, desc, and, asc }  from 'drizzle-orm'
import { v7 as uuidv7 }        from 'uuid'
import { db }                  from '../db/client.js'
import {
  auditRuns, auditFindings, buildTasks, events,
}                              from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

type AuditCategory =
  | 'critical_runtime'
  | 'security'
  | 'budget_cost'
  | 'replay_rollback'
  | 'provider_routing'
  | 'ui_wiring'
  | 'testing'
  | 'polish'

type Severity = 'critical' | 'high' | 'medium' | 'low'

interface AuditPattern {
  id:           string
  regex:        RegExp
  category:     AuditCategory
  severity:     Severity
  description:  string
  suggestion:   string
  onlyDirs?:    string[]   // only scan if file path contains one of these
  excludeFile?: RegExp
}

interface RawFinding {
  patternId:   string
  category:    AuditCategory
  severity:    Severity
  filePath:    string
  lineNumber:  number
  matchedText: string
  description: string
  suggestion:  string
}

// ─── Pattern catalogue ────────────────────────────────────────────────────────

const PATTERNS: AuditPattern[] = [
  {
    id:          'fake-simulation',
    regex:       /simulat[eE](?:d)?\s*(?:Patch|Result|Data|Test|Job|Run)\b/,
    category:    'critical_runtime',
    severity:    'critical',
    description: 'Simulated/fake operation — no real work performed',
    suggestion:  'Replace with real implementation (actual file I/O or command execution)',
    excludeFile: /repo-auditor/,
  },
  {
    id:          'hardcoded-pass',
    regex:       /(?:validationPassed|testsPassed)\s*=\s*true\s*\/\//,
    category:    'critical_runtime',
    severity:    'critical',
    description: 'Hardcoded pass value — real validation never executed',
    suggestion:  'Wire to actual tsc/vitest/eslint command output from verification-engine',
  },
  {
    id:          'not-implemented',
    regex:       /throw new Error\(\s*['"`](?:not implemented|unimplemented|TODO|STUB)/i,
    category:    'critical_runtime',
    severity:    'critical',
    description: 'Unimplemented stub — throws at runtime',
    suggestion:  'Implement or remove if unreachable',
  },
  {
    id:          'in-memory-map',
    // Only flag MODULE-LEVEL stores (no indentation). Local Maps inside
    // functions for lookup/aggregation are not persistent state.
    regex:       /^(?:const|let)\s+\w+\s*=\s*new Map(?:<[^>]*>)?\(\)/m,
    category:    'critical_runtime',
    severity:    'high',
    description: 'In-memory Map store — not persisted across restarts',
    suggestion:  'Migrate to Postgres table for production durability',
    onlyDirs:    ['services'],
    excludeFile: /test|spec|auditor|scanner|executor/,
  },
  {
    id:          'fake-marker',
    // Test files legitimately use mocks/stubs — exclude them.
    // Tightened: only catch explicit FAKE/placeholder markers, not 'MOCK' or
    // 'simulated' which appear in legitimate test/docstring contexts.
    regex:       /\/\/\s*(?:FAKE|placeholder)[:!]\s*.{0,60}/i,
    category:    'critical_runtime',
    severity:    'high',
    description: 'Fake/mock/stub marker in production code',
    suggestion:  'Replace with real implementation before production deploy',
    excludeFile: /test|spec|repo-auditor/,
  },
  {
    id:          'hardcoded-ws',
    // 'default' is a legitimate fallback string ('?? "default"'); keep only
    // the obviously-test-only workspace ids.
    regex:       /['"](?:ws-test-001|workspace-1|test-workspace)['"]/,
    category:    'ui_wiring',
    severity:    'medium',
    description: 'Hardcoded workspace ID in production code',
    suggestion:  'Use useWorkspace() hook or workspace_id query param',
    excludeFile: /test|spec|MEMORY|\.md|WorkspaceContext/,
  },
  {
    id:          'todo-fixme',
    regex:       /\/\/\s*(?:TODO|FIXME|HACK|XXX)[:!]?\s*.{0,80}/i,
    category:    'polish',
    severity:    'low',
    description: 'TODO/FIXME comment — unresolved work item',
    suggestion:  'Convert to tracked build task or resolve',
  },
  {
    id:          'math-random-prod',
    regex:       /Math\.random\(\)\s*(?:\*|<|>)/,
    category:    'testing',
    severity:    'medium',
    description: 'Math.random() in production logic — non-deterministic, breaks reproducibility',
    suggestion:  'Use seeded RNG or deterministic calculation',
    onlyDirs:    ['services', 'routes'],
  },
  {
    id:          'empty-catch',
    regex:       /\}\s*catch\s*\([^)]*\)\s*\{\s*\}/,
    category:    'critical_runtime',
    severity:    'medium',
    description: 'Empty catch block — errors silently swallowed',
    suggestion:  'Log or re-throw the caught error',
  },
  {
    id:          'console-debug',
    regex:       /console\.(?:log|debug)\s*\(/,
    category:    'polish',
    severity:    'low',
    description: 'console.log/debug in production service code',
    suggestion:  'Replace with structured logger (fastify.log or pino)',
    onlyDirs:    ['services', 'routes'],
    excludeFile: /test|spec|telemetry/,
  },
]

// ─── Agent / priority maps ─────────────────────────────────────────────────────

const CATEGORY_AGENT: Record<AuditCategory, string> = {
  critical_runtime:  'coder',
  security:          'security',
  budget_cost:       'cto',
  replay_rollback:   'reliability',
  provider_routing:  'planner',
  ui_wiring:         'coder',
  testing:           'tester',
  polish:            'coder',
}

const SEVERITY_BASE_PRIORITY: Record<Severity, number> = {
  critical: 5,
  high:     15,
  medium:   25,
  low:      40,
}

const CATEGORY_OFFSET: Record<AuditCategory, number> = {
  critical_runtime: 0,
  security:         1,
  budget_cost:      2,
  replay_rollback:  3,
  provider_routing: 4,
  ui_wiring:        5,
  testing:          6,
  polish:           7,
}

// ─── File walker ──────────────────────────────────────────────────────────────

const SCAN_EXTS  = new Set(['.ts', '.tsx'])
const SKIP_DIRS  = new Set(['node_modules', 'dist', 'build', '.git', '.turbo', 'coverage', 'logs'])
const MAX_FILE_BYTES = 300_000
const MAX_FINDINGS   = 400
const MAX_PER_PATTERN_PER_FILE = 3

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: string[]
    try { entries = await readdir(d) } catch { return }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(d, name)
      const ext  = extname(name)
      if (SCAN_EXTS.has(ext)) { out.push(full) }
      else if (ext === '') { await walk(full, depth + 1) }
    }
  }
  await walk(dir, 0)
  return out
}

// ─── Pattern scanner ──────────────────────────────────────────────────────────

async function scanFileForPatterns(filePath: string): Promise<RawFinding[]> {
  let content: string
  try {
    const buf = await readFile(filePath)
    if (buf.length > MAX_FILE_BYTES) return []
    content = buf.toString('utf8')
  } catch { return [] }

  const lines    = content.split('\n')
  const results: RawFinding[] = []
  const normPath = filePath.replace(/\\/g, '/')

  for (const pat of PATTERNS) {
    if (pat.excludeFile?.test(normPath)) continue
    if (pat.onlyDirs && !pat.onlyDirs.some(d => normPath.includes(`/${d}/`))) continue

    let count = 0
    for (let i = 0; i < lines.length && count < MAX_PER_PATTERN_PER_FILE; i++) {
      const line = lines[i] ?? ''
      if (!line.trim()) continue
      const match = pat.regex.exec(line)
      if (match) {
        results.push({
          patternId:   pat.id,
          category:    pat.category,
          severity:    pat.severity,
          filePath:    normPath,
          lineNumber:  i + 1,
          matchedText: match[0].slice(0, 200),
          description: pat.description,
          suggestion:  pat.suggestion,
        })
        count++
      }
    }
  }

  return results
}

// ─── Structural checks ────────────────────────────────────────────────────────

async function checkTestCoverage(apiSrcPath: string): Promise<RawFinding[]> {
  const servicesDir = join(apiSrcPath, 'services')
  const testDir     = join(apiSrcPath, 'test')

  let serviceEntries: string[] = []
  let testEntries:    string[] = []
  try { serviceEntries = await readdir(servicesDir) } catch { return [] }
  try { testEntries    = await readdir(testDir)     } catch { return [] }

  const testedNames = new Set(
    testEntries.filter(f => f.endsWith('.test.ts')).map(f => basename(f, '.test.ts'))
  )

  // Prioritise critical services
  const CRITICAL_SERVICES = new Set([
    'agent-patch-pipeline', 'provider-router', 'budget-guard',
    'verification-engine', 'patch-executor', 'autonomous-orchestrator',
    'lease-manager', 'disaster-recovery', 'deploy-guard',
  ])

  return serviceEntries
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map(f => basename(f, '.ts'))
    .filter(name => !testedNames.has(name))
    .map(name => ({
      patternId:   'missing-test',
      category:    'testing' as AuditCategory,
      severity:    (CRITICAL_SERVICES.has(name) ? 'high' : 'medium') as Severity,
      filePath:    join(servicesDir, `${name}.ts`).replace(/\\/g, '/'),
      lineNumber:  1,
      matchedText: name,
      description: `No test file for service: ${name}`,
      suggestion:  `Create apps/api/src/test/${name}.test.ts covering critical paths`,
    }))
}

async function checkFrontendRouteGaps(webSrcPath: string): Promise<RawFinding[]> {
  const appPath = join(webSrcPath, 'App.tsx')
  let appContent = ''
  try { appContent = await readFile(appPath, 'utf8') } catch { return [] }

  // Collect defined route paths
  const defined = new Set<string>()
  const routeRe = /path="([^"*]+)"/g
  let m: RegExpExecArray | null
  while ((m = routeRe.exec(appContent)) !== null) { defined.add(m[1]!) }

  // Scan pages for to= links that point to undefined routes
  const pagesDir = join(webSrcPath, 'pages')
  let pageFiles: string[] = []
  try { pageFiles = await readdir(pagesDir) } catch { return [] }

  const findings: RawFinding[] = []
  const seen = new Set<string>()  // avoid duplicate path findings

  for (const fname of pageFiles) {
    if (!fname.endsWith('.tsx')) continue
    const full = join(pagesDir, fname)
    let content = ''
    try { content = await readFile(full, 'utf8') } catch { continue }

    const linkRe = /to="(\/[^"?#]+)"/g
    while ((m = linkRe.exec(content)) !== null) {
      const path = m[1]!
      if (path.startsWith('/api')) continue
      if (defined.has(path) || seen.has(path)) continue
      // Check if any defined route is a prefix match (e.g. /compute matches /compute/settings)
      const covered = [...defined].some(d => d !== '/' && path.startsWith(d))
      if (covered) continue
      seen.add(path)
      const lineNum = content.slice(0, m.index).split('\n').length
      findings.push({
        patternId:   'dead-frontend-link',
        category:    'ui_wiring',
        severity:    'medium',
        filePath:    full.replace(/\\/g, '/'),
        lineNumber:  lineNum,
        matchedText: path,
        description: `Frontend link to "${path}" has no Route in App.tsx`,
        suggestion:  `Add <Route path="${path}" .../> to App.tsx or remove the link`,
      })
    }
  }

  return findings
}

// ─── Build task generator ─────────────────────────────────────────────────────

interface TaskSpec {
  title:            string
  description:      string
  category:         AuditCategory
  severity:         Severity
  priority:         number
  filePath:         string
  requiresApproval: boolean
  blastRadius:      string
  assignedAgent:    string
  findingKey:       string
}

function findingsToTasks(findings: RawFinding[]): TaskSpec[] {
  // Group by patternId + filePath so one file's repeated matches → one task
  const groups = new Map<string, RawFinding[]>()
  for (const f of findings) {
    const key = `${f.patternId}::${f.filePath}`
    const g   = groups.get(key) ?? []
    g.push(f)
    groups.set(key, g)
  }

  const tasks: TaskSpec[] = []
  for (const [key, group] of groups) {
    const rep      = group[0]!
    const lineRefs = group.map(f => `L${f.lineNumber}`).join(', ')
    const priority = SEVERITY_BASE_PRIORITY[rep.severity] + CATEGORY_OFFSET[rep.category]

    tasks.push({
      findingKey:       key,
      title:            `[${rep.category.replace(/_/g, ' ').toUpperCase()}] ${rep.description} — ${basename(rep.filePath)}`,
      description:      `${rep.description}. Matches at ${lineRefs}. ${rep.suggestion}`,
      category:         rep.category,
      severity:         rep.severity,
      priority,
      filePath:         rep.filePath,
      requiresApproval: rep.category === 'critical_runtime' || rep.category === 'security',
      blastRadius:      rep.severity === 'critical' ? 'critical'
                      : rep.severity === 'high'     ? 'high'
                      : rep.severity === 'medium'   ? 'medium' : 'low',
      assignedAgent:    CATEGORY_AGENT[rep.category],
    })
  }

  tasks.sort((a, b) => a.priority - b.priority)
  return tasks
}

// ─── Main audit runner ────────────────────────────────────────────────────────

const REPO_ROOT = process.env['REPO_ROOT'] ?? process.cwd()

export interface AuditSummary {
  runId:         string
  filesScanned:  number
  findingCount:  number
  criticalCount: number
  highCount:     number
  taskCount:     number
  byCategory:    Record<string, number>
  bySeverity:    Record<string, number>
  topTasks:      Array<{ id: string; title: string; severity: string; priority: number; requiresApproval: boolean }>
}

export async function runAudit(workspaceId: string): Promise<AuditSummary> {
  const runId = uuidv7()
  const now   = Date.now()

  await db.insert(auditRuns).values({
    id: runId, workspaceId, status: 'running', rootPath: REPO_ROOT,
    createdAt: now, updatedAt: now,
  })

  await db.insert(events).values({
    id: uuidv7(), type: 'audit.run.started', workspaceId,
    payload: { runId, rootPath: REPO_ROOT },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'repo-auditor', version: 1, createdAt: now,
  }).catch(() => null)

  try {
    // 1. Walk and pattern-scan
    const apiSrc = join(REPO_ROOT, 'apps', 'api', 'src')
    const webSrc = join(REPO_ROOT, 'apps', 'web', 'src')

    const allFiles = [
      ...await walkFiles(apiSrc),
      ...await walkFiles(webSrc),
    ]

    const rawFindings: RawFinding[] = []

    for (const f of allFiles) {
      if (rawFindings.length >= MAX_FINDINGS) break
      const found = await scanFileForPatterns(f)
      rawFindings.push(...found)
    }

    // 2. Structural checks
    const testFindings   = await checkTestCoverage(apiSrc)
    const routeFindings  = await checkFrontendRouteGaps(webSrc)
    rawFindings.push(...testFindings, ...routeFindings)

    // Cap total
    const capped = rawFindings.slice(0, MAX_FINDINGS)

    // 3. Persist findings
    const findingRecords: (typeof auditFindings.$inferInsert)[] = capped.map(f => ({
      id:          uuidv7(),
      auditRunId:  runId,
      workspaceId,
      category:    f.category,
      severity:    f.severity,
      patternId:   f.patternId,
      filePath:    f.filePath,
      lineNumber:  f.lineNumber,
      matchedText: f.matchedText,
      description: f.description,
      suggestion:  f.suggestion,
      createdAt:   Date.now(),
    }))

    if (findingRecords.length > 0) {
      // Insert in batches of 50
      for (let i = 0; i < findingRecords.length; i += 50) {
        await db.insert(auditFindings).values(findingRecords.slice(i, i + 50))
      }
    }

    // 4. Generate build tasks
    const taskSpecs  = findingsToTasks(capped)
    const taskRecords: (typeof buildTasks.$inferInsert)[] = taskSpecs.map((t) => {
      // find primary finding id for this task
      const primaryFinding = findingRecords.find(f =>
        `${f.patternId}::${f.filePath}` === t.findingKey
      )
      return {
        id:               uuidv7(),
        auditRunId:       runId,
        findingId:        primaryFinding?.id ?? null,
        workspaceId,
        title:            t.title,
        description:      t.description,
        category:         t.category,
        severity:         t.severity,
        priority:         t.priority,
        status:           t.requiresApproval ? 'approval_required' : 'pending',
        requiresApproval: t.requiresApproval,
        assignedAgent:    t.assignedAgent,
        blastRadius:      t.blastRadius,
        filePath:         t.filePath,
        createdAt:        Date.now(),
        updatedAt:        Date.now(),
      }
    })

    if (taskRecords.length > 0) {
      for (let i = 0; i < taskRecords.length; i += 50) {
        await db.insert(buildTasks).values(taskRecords.slice(i, i + 50))
      }
    }

    // 5. Aggregate counts
    const criticalCount = capped.filter(f => f.severity === 'critical').length
    const highCount     = capped.filter(f => f.severity === 'high').length
    const byCategory:   Record<string, number> = {}
    const bySeverity:   Record<string, number> = {}

    for (const f of capped) {
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
    }

    // 6. Update run record
    await db.update(auditRuns).set({
      status:       'complete',
      filesScanned: allFiles.length,
      findingCount: capped.length,
      criticalCount,
      highCount,
      taskCount:    taskRecords.length,
      completedAt:  Date.now(),
      updatedAt:    Date.now(),
    }).where(eq(auditRuns.id, runId))

    await db.insert(events).values({
      id: uuidv7(), type: 'audit.run.complete', workspaceId,
      payload: { runId, findingCount: capped.length, criticalCount, taskCount: taskRecords.length },
      traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
      source: 'repo-auditor', version: 1, createdAt: Date.now(),
    }).catch(() => null)

    const topTasks = taskRecords.slice(0, 10).map(t => ({
      id:               t.id,
      title:            t.title,
      severity:         t.severity,
      priority:         t.priority         ?? 50,
      requiresApproval: t.requiresApproval ?? false,
    }))

    return {
      runId, filesScanned: allFiles.length,
      findingCount: capped.length, criticalCount, highCount,
      taskCount: taskRecords.length, byCategory, bySeverity, topTasks,
    }

  } catch (err) {
    await db.update(auditRuns).set({
      status: 'failed', errorMessage: String(err),
      completedAt: Date.now(), updatedAt: Date.now(),
    }).where(eq(auditRuns.id, runId))
    throw err
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export async function listAuditRuns(workspaceId: string, limit = 20) {
  return db.select().from(auditRuns)
    .where(eq(auditRuns.workspaceId, workspaceId))
    .orderBy(desc(auditRuns.createdAt))
    .limit(limit)
}

export async function getAuditRun(id: string) {
  const rows = await db.select().from(auditRuns).where(eq(auditRuns.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getAuditFindings(
  runId: string,
  filter?: { category?: string; severity?: string }
) {
  if (filter?.category) {
    return db.select().from(auditFindings)
      .where(and(eq(auditFindings.auditRunId, runId), eq(auditFindings.category, filter.category)))
      .orderBy(desc(auditFindings.createdAt)).limit(500)
  }
  return db.select().from(auditFindings)
    .where(eq(auditFindings.auditRunId, runId))
    .orderBy(desc(auditFindings.createdAt)).limit(500)
}

export async function getBuildTasks(runId: string, limit = 100) {
  return db.select().from(buildTasks)
    .where(eq(buildTasks.auditRunId, runId))
    .orderBy(asc(buildTasks.priority))
    .limit(limit)
}
