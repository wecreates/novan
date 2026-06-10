/**
 * R597 — Agent-OS parity completion.
 *
 * Builds on R596 (standards registry) to close the remaining gaps:
 *
 *   A. standards.discover — scan repo files for recurring patterns and propose
 *      candidate standards the operator can promote with standards.upsert.
 *      Mirrors Agent OS `/discover-standards`.
 *
 *   B. standards.inject explicit targeting — by slugs[] or category, mirrors
 *      `/inject-standards api/auth`. The existing R596 standards.inject is the
 *      auto path; here we add the explicit selector path.
 *
 *   C. spec.archive — persist a timestamped spec folder per feature
 *      (plan + shape + standards + references), the way Agent OS lays out
 *      .agent-os/specs/[TS]-[slug]/. Stored in `spec_artifacts` table.
 *
 *   D. product.{set,get} — mission / roadmap / tech-stack as queryable rows,
 *      the way Agent OS keeps .agent-os/product/{mission,roadmap,tech-stack}.md.
 *
 * Discovery is heuristic and safe: read-only, capped at MAX_FILES files and
 * MAX_BYTES bytes per file, returns proposed standards but does NOT auto-insert.
 * Operator (or chat) promotes via standards.upsert.
 */
import { sql } from 'drizzle-orm'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { db } from '../db/client.js'

// ─── Discover ────────────────────────────────────────────────────────────────

const REPO_ROOT = process.env['REPO_ROOT'] ?? '/app'
const MAX_FILES = 120
const MAX_BYTES = 200_000

interface PatternRule {
  slug:        string
  category:    string
  title:       string
  body:        string
  regex:       RegExp
  globs:       string[]
  keywords:    string[]
  importance:  number
  minHits:     number
}

const PATTERN_RULES: PatternRule[] = [
  {
    slug: 'ddl-tolerated-catch-detected',
    category: 'database',
    title: 'CREATE-IF-NOT-EXISTS DDL wrapped in tolerated catch',
    body: 'Service-side `CREATE TABLE/INDEX IF NOT EXISTS` calls are wrapped in `.catch(() => {})` so concurrent booting instances do not crash on race. Apply this pattern for any new ensureTable() helpers.',
    regex: /CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS[^`]*`\s*\)\s*\.catch\(\s*\(\s*\)\s*=>\s*\{?\s*\}?\s*\)/i,
    globs: ['apps/api/src/services/*.ts'],
    keywords: ['createtable', 'createindex', 'ensuretable', 'ddl'],
    importance: 80, minHits: 3,
  },
  {
    slug: 'sql-tagged-template-detected',
    category: 'database',
    title: 'Drizzle sql`` tagged-template for raw SQL',
    body: 'All raw SQL goes through Drizzle\'s `sql` template literal: `await db.execute(sql\\`...\\`)`. Never string-concatenate user input into SQL. Never use db.execute with a plain string. Parameter interpolation via `${value}` is the only safe path.',
    regex: /await\s+db\.execute\(\s*sql`/,
    globs: ['apps/api/src/services/*.ts', 'apps/api/src/routes/*.ts'],
    keywords: ['sql', 'drizzle', 'db.execute', 'query'],
    importance: 90, minHits: 5,
  },
  {
    slug: 'cron-lock-pattern-detected',
    category: 'cron',
    title: 'withCronLock wraps tick bodies',
    body: 'Scheduled tick bodies that touch shared state acquire a Postgres advisory lock via `withCronLock(name, fn)`. Per-business ticks lock on `${cronName}|${businessId}`. Never run a tick without a lock — two replicas firing simultaneously will double-write.',
    regex: /withCronLock\s*\(/,
    globs: ['apps/api/src/services/*cron*.ts', 'apps/api/src/services/r58*.ts', 'apps/api/src/services/r504*.ts'],
    keywords: ['cron', 'withcronlock', 'advisorylock', 'tick'],
    importance: 85, minHits: 2,
  },
  {
    slug: 'brain-op-shape-detected',
    category: 'brain',
    title: 'Brain op shape: { description, risk, handler }',
    body: 'Every brain op is an object literal in `brain-task.ts` OPERATIONS with exactly three keys: `description` (string, leads with Rxxx tag + params), `risk` (\'low\'|\'medium\'|\'high\'), `handler: async (ws, params) => ...`. New ops must also be added to the admin-bridge allowlist and INFO_OPS skip list (if no chat output).',
    regex: /'\w+\.\w+':\s*\{\s*description:[^,]+,\s*risk:\s*'(?:low|medium|high)',\s*handler:\s*async\s*\(/,
    globs: ['apps/api/src/services/brain-task.ts'],
    keywords: ['brainop', 'op', 'handler', 'risk', 'description'],
    importance: 95, minHits: 5,
  },
  {
    slug: 'r587-fanout-pattern-detected',
    category: 'multibusiness',
    title: 'R587 runForEachBusiness for per-business work',
    body: 'Any work that should fan out across all businesses uses `runForEachBusiness(workspaceId, cronName, async (bizId, bizName) => {...})`. The helper enforces per-business autonomy gate, budget gate, advisory lock, and per-business error isolation. Never iterate businesses by hand.',
    regex: /runForEachBusiness\s*\(/,
    globs: ['apps/api/src/services/*.ts'],
    keywords: ['fanout', 'perbusiness', 'business_id', 'runforeach', 'multibusiness'],
    importance: 85, minHits: 1,
  },
  {
    slug: 'event-emit-pattern-detected',
    category: 'observability',
    title: 'await emit() for structured events',
    body: 'State transitions that the operator may want to inspect later go to `await emit(\'category.action\', payload)`. The events table is the audit log + the brain\'s long-term memory. Prefer one well-structured emit() over multiple console logs.',
    regex: /await\s+emit\(\s*['"]\w+\.\w+/,
    globs: ['apps/api/src/services/*.ts'],
    keywords: ['emit', 'event', 'audit', 'observability', 'log'],
    importance: 70, minHits: 5,
  },
]

async function walkRepo(root: string, globRegex: RegExp, max: number): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(dir, e.name)
      // Skip volume noise.
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name.startsWith('.')) continue
      if (e.isDirectory()) { stack.push(full); continue }
      const rel = relative(root, full).replace(/\\/g, '/')
      if (globRegex.test(rel)) out.push(rel)
      if (out.length >= max) break
    }
  }
  return out
}

function globsToRegex(globs: string[]): RegExp {
  // Each glob: ** = .*, * = [^/]*
  const parts = globs.map(g => g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DS>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DS>>/g, '.*'))
  return new RegExp('^(?:' + parts.join('|') + ')$')
}

export interface DiscoveredCandidate {
  slug:       string
  category:   string
  title:      string
  body:       string
  hits:       number
  exampleFiles: string[]
  detectionGlobs:    string[]
  detectionKeywords: string[]
  importance: number
  alreadyExists?: boolean
}

export async function discoverStandards(workspaceId: string, pathGlobs?: string[]): Promise<DiscoveredCandidate[]> {
  const root = resolve(REPO_ROOT)
  const effectiveRules = pathGlobs && pathGlobs.length > 0
    ? PATTERN_RULES.filter(r => r.globs.some(g => pathGlobs.includes(g)))
    : PATTERN_RULES
  const allGlobs = Array.from(new Set(effectiveRules.flatMap(r => r.globs)))
  const fileRegex = globsToRegex(allGlobs)
  const files = await walkRepo(root, fileRegex, MAX_FILES)

  // Pre-count existing standards to flag duplicates without DB churn.
  const { listStandards } = await import('./r596-coding-standards.js')
  const existing = new Set((await listStandards(workspaceId)).map(s => s.slug))

  const stats: Record<string, { hits: number; files: Set<string> }> = {}
  for (const rule of effectiveRules) stats[rule.slug] = { hits: 0, files: new Set() }

  for (const f of files) {
    let body: string
    try {
      const full = join(root, f)
      const st = await stat(full)
      if (st.size > MAX_BYTES) continue
      body = await readFile(full, 'utf-8')
    } catch { continue }
    for (const rule of effectiveRules) {
      const ruleGlob = globsToRegex(rule.globs)
      if (!ruleGlob.test(f)) continue
      const matches = body.match(new RegExp(rule.regex.source, rule.regex.flags + 'g')) ?? []
      if (matches.length > 0) {
        stats[rule.slug]!.hits += matches.length
        if (stats[rule.slug]!.files.size < 5) stats[rule.slug]!.files.add(f)
      }
    }
  }

  const out: DiscoveredCandidate[] = []
  for (const rule of effectiveRules) {
    const s = stats[rule.slug]!
    if (s.hits < rule.minHits) continue
    out.push({
      slug: rule.slug, category: rule.category, title: rule.title, body: rule.body,
      hits: s.hits, exampleFiles: Array.from(s.files),
      detectionGlobs: rule.globs, detectionKeywords: rule.keywords,
      importance: rule.importance, alreadyExists: existing.has(rule.slug),
    })
  }
  out.sort((a, b) => b.hits - a.hits)
  return out
}

/** Promote a discovered candidate into the standards registry. */
export async function promoteDiscovered(workspaceId: string, candidate: DiscoveredCandidate): Promise<{ ok: boolean; slug: string }> {
  const { upsertStandard } = await import('./r596-coding-standards.js')
  await upsertStandard(workspaceId, {
    slug: candidate.slug, category: candidate.category, title: candidate.title,
    body: candidate.body,
    detectionGlobs: candidate.detectionGlobs, detectionKeywords: candidate.detectionKeywords,
    importance: candidate.importance,
  })
  return { ok: true, slug: candidate.slug }
}

// ─── Explicit injection targeting ───────────────────────────────────────────

export interface ExplicitInjectInput {
  slugs?:    string[]
  category?: string
}

/** Build a standards block by explicit slugs or category — no detection logic. */
export async function injectExplicit(workspaceId: string, input: ExplicitInjectInput): Promise<{ block: string; count: number }> {
  const { listStandards, buildStandardsBlock } = await import('./r596-coding-standards.js')
  const all = await listStandards(workspaceId, input.category)
  const filtered = input.slugs && input.slugs.length > 0
    ? all.filter(s => input.slugs!.includes(s.slug))
    : all
  // Build hits compatible with buildStandardsBlock; score = importance/100.
  const hits = filtered.map(s => ({ standard: s, score: s.importance / 100, reason: 'explicit' }))
  return { block: buildStandardsBlock(hits), count: hits.length }
}

// ─── Spec archive ────────────────────────────────────────────────────────────

async function ensureSpecTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS spec_artifacts (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,
      slug            TEXT NOT NULL,
      title           TEXT NOT NULL,
      plan_md         TEXT,
      shape_md        TEXT,
      standards_md    TEXT,
      references_json JSONB DEFAULT '[]'::jsonb,
      visuals_json    JSONB DEFAULT '[]'::jsonb,
      created_at      BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS spec_artifacts_ws_idx ON spec_artifacts (workspace_id, created_at DESC)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS spec_artifacts_ws_biz_idx ON spec_artifacts (workspace_id, business_id, created_at DESC) WHERE business_id IS NOT NULL`).catch(() => {})
}

export interface SpecArchiveInput {
  slug:        string
  title:       string
  planMd:      string
  shapeMd?:    string
  references?: Array<{ file: string; lines?: string; note?: string }>
  visuals?:    Array<{ kind: string; url?: string; alt?: string }>
  businessId?: string
  description?: string  // used to auto-attach applicable standards
}

export async function archiveSpec(workspaceId: string, input: SpecArchiveInput): Promise<{ id: string; ts: string; standardsAttached: number }> {
  await ensureSpecTable()
  const { v7: uuidv7 } = await import('uuid')
  const id = uuidv7()
  const now = Date.now()
  const d = new Date(now)
  const ts = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`

  // Auto-attach applicable standards into standards_md snapshot.
  let standardsMd = ''
  let standardsAttached = 0
  try {
    const { applicableStandards, buildStandardsBlock } = await import('./r596-coding-standards.js')
    const hits = await applicableStandards(workspaceId, { description: input.description ?? input.title, keywords: [input.slug] }, 8)
    standardsMd = buildStandardsBlock(hits)
    standardsAttached = hits.length
  } catch { /* tolerated */ }

  await db.execute(sql`
    INSERT INTO spec_artifacts (id, workspace_id, business_id, slug, title, plan_md, shape_md, standards_md, references_json, visuals_json, created_at)
    VALUES (${id}, ${workspaceId}, ${input.businessId ?? null}, ${input.slug}, ${input.title},
            ${input.planMd}, ${input.shapeMd ?? null}, ${standardsMd},
            ${JSON.stringify(input.references ?? [])}::jsonb,
            ${JSON.stringify(input.visuals ?? [])}::jsonb,
            ${now})
  `).catch(() => {})
  return { id, ts: `${ts}-${input.slug}`, standardsAttached }
}

export async function listSpecs(workspaceId: string, limit = 20): Promise<Array<{ id: string; slug: string; title: string; createdAt: number; standardsAttached: boolean; refsCount: number }>> {
  await ensureSpecTable()
  const r = await db.execute(sql`
    SELECT id, slug, title, created_at,
           (standards_md IS NOT NULL AND standards_md <> '') AS has_std,
           jsonb_array_length(COALESCE(references_json, '[]'::jsonb)) AS refs_count
    FROM spec_artifacts WHERE workspace_id = ${workspaceId}
    ORDER BY created_at DESC LIMIT ${Math.min(limit, 100)}
  `).catch(() => [] as unknown[])
  return (r as unknown as Array<{ id: string; slug: string; title: string; created_at: number; has_std: boolean; refs_count: number }>)
    .map(x => ({ id: x.id, slug: x.slug, title: x.title, createdAt: Number(x.created_at), standardsAttached: !!x.has_std, refsCount: Number(x.refs_count) }))
}

export async function getSpec(workspaceId: string, id: string): Promise<{ id: string; slug: string; title: string; planMd: string | null; shapeMd: string | null; standardsMd: string | null; references: unknown[]; visuals: unknown[]; createdAt: number } | null> {
  await ensureSpecTable()
  const r = await db.execute(sql`SELECT * FROM spec_artifacts WHERE workspace_id = ${workspaceId} AND id = ${id} LIMIT 1`).catch(() => [] as unknown[])
  const row = (r as unknown as Array<{ id: string; slug: string; title: string; plan_md: string | null; shape_md: string | null; standards_md: string | null; references_json: unknown[]; visuals_json: unknown[]; created_at: number }>)[0]
  if (!row) return null
  return {
    id: row.id, slug: row.slug, title: row.title, planMd: row.plan_md, shapeMd: row.shape_md,
    standardsMd: row.standards_md, references: row.references_json ?? [], visuals: row.visuals_json ?? [],
    createdAt: Number(row.created_at),
  }
}

// ─── Product artifacts (mission / roadmap / techstack) ───────────────────────

const PRODUCT_KINDS = new Set(['mission', 'roadmap', 'techstack'])

async function ensureProductTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS product_artifacts (
      workspace_id  TEXT NOT NULL,
      business_id   TEXT NOT NULL DEFAULT '',
      kind          TEXT NOT NULL,
      body_md       TEXT NOT NULL,
      updated_at    BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, business_id, kind)
    )
  `).catch(() => {})
}

export async function setProduct(workspaceId: string, kind: string, bodyMd: string, businessId?: string): Promise<void> {
  if (!PRODUCT_KINDS.has(kind)) throw new Error(`unknown product kind: ${kind} (allowed: ${[...PRODUCT_KINDS].join(', ')})`)
  await ensureProductTable()
  await db.execute(sql`
    INSERT INTO product_artifacts (workspace_id, business_id, kind, body_md, updated_at)
    VALUES (${workspaceId}, ${businessId ?? ''}, ${kind}, ${bodyMd}, ${Date.now()})
    ON CONFLICT (workspace_id, business_id, kind) DO UPDATE SET
      body_md    = EXCLUDED.body_md,
      updated_at = EXCLUDED.updated_at
  `).catch(() => {})
}

export async function getProduct(workspaceId: string, kind: string, businessId?: string): Promise<{ kind: string; bodyMd: string; updatedAt: number } | null> {
  await ensureProductTable()
  const r = await db.execute(sql`
    SELECT kind, body_md, updated_at FROM product_artifacts
    WHERE workspace_id = ${workspaceId} AND kind = ${kind} AND business_id = ${businessId ?? ''}
    LIMIT 1
  `).catch(() => [] as unknown[])
  const row = (r as unknown as Array<{ kind: string; body_md: string; updated_at: number }>)[0]
  if (!row) return null
  return { kind: row.kind, bodyMd: row.body_md, updatedAt: Number(row.updated_at) }
}

export async function listProduct(workspaceId: string, businessId?: string): Promise<Array<{ kind: string; bodyMd: string; updatedAt: number }>> {
  await ensureProductTable()
  const r = await db.execute(sql`
    SELECT kind, body_md, updated_at FROM product_artifacts
    WHERE workspace_id = ${workspaceId} AND business_id = ${businessId ?? ''}
    ORDER BY kind
  `).catch(() => [] as unknown[])
  return (r as unknown as Array<{ kind: string; body_md: string; updated_at: number }>).map(x => ({ kind: x.kind, bodyMd: x.body_md, updatedAt: Number(x.updated_at) }))
}

/** Build a product-context block for brain-loop injection (mission first, then techstack summary). */
export async function buildProductContextBlock(workspaceId: string, businessId?: string): Promise<string> {
  const items = await listProduct(workspaceId, businessId)
  if (items.length === 0) return ''
  const lines: string[] = ['<!-- R597 product context (mission/roadmap/tech-stack) -->']
  for (const it of items) {
    lines.push(`## ${it.kind}`)
    lines.push(it.bodyMd.trim().slice(0, 800))
    lines.push('')
  }
  return lines.join('\n')
}
