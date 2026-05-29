/**
 * skill-library.ts — imported instructional knowledge library.
 *
 * Holds external SKILL.md files (e.g. from awesome-copilot) as
 * reference documents the brain or operator can search + apply.
 *
 * Distinct from `skills.ts`, which is for executable workflow skills.
 *
 * Two concerns kept together because they're one feature:
 *
 *   1. INGEST — walk a directory of `<slug>/SKILL.md` files (YAML
 *      frontmatter + markdown body), parse, persist with file-hash
 *      dedup. Idempotent: re-running over the same folder updates
 *      changed files and skips unchanged ones.
 *
 *   2. QUERY — list/search/get + recordUsage. Search is keyword-based
 *      via PG ilike across name + description + slug. Embedding-based
 *      semantic search is a separate improvement.
 *
 * Honest scope:
 *   - Library rows are STORED text, not executable agents.
 *   - A skill becomes "active" only when something explicitly pulls
 *     it via the API and injects its body into a prompt or shows it
 *     to the operator. Usage counter is bumped at that moment.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { skillLibrary, events } from '../db/schema.js'

// ── Frontmatter parser (handles the awesome-copilot shape) ────────────

export interface ParsedSkillFields {
  name:        string
  description: string
  body:        string
  license:     string | null
}

/**
 * Parse a SKILL.md file. Supports YAML frontmatter delimited by `---`.
 * Recognizes `name`, `description`, `license`. Values may be plain
 * (foo: bar) or single/double-quoted ('foo: bar with: colons').
 *
 * If frontmatter is missing, falls back to using the first H1 as the
 * name and the first paragraph as description.
 */
export function parseSkillFile(raw: string, slug: string): ParsedSkillFields {
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (fm) {
    const block = fm[1]!
    const body  = (fm[2] ?? '').trim()
    const fields: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.+)$/)
      if (!m) continue
      const key = m[1]!.toLowerCase()
      let val = (m[2] ?? '').trim()
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1)
      }
      fields[key] = val
    }
    return {
      name:        fields['name']        ?? slug,
      description: fields['description'] ?? '',
      body,
      license:     fields['license']     ?? null,
    }
  }
  const h1 = raw.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const firstPara = raw.split(/\n\s*\n/)[1]?.trim().slice(0, 300) ?? ''
  return {
    name:        h1 ?? slug,
    description: firstPara,
    body:        raw,
    license:     null,
  }
}

// ── Category heuristic ───────────────────────────────────────────────

const CATEGORY_RULES: Array<[string, RegExp]> = [
  ['azure',       /\b(azure|az[-]|aspire|bicep|avm)\b/i],
  ['dotnet',      /\b(dotnet|csharp|aspnet|aspnetcore|mvvm|ef[-]?core|nuget)\b/i],
  ['java',        /\b(java|kotlin|spring[-]?boot|junit|graalvm|jakarta)\b/i],
  ['react',       /\b(react|jsx|tsx|enzyme|rtl)\b/i],
  ['python',      /\b(python|pytest|ruff|django|flask)\b/i],
  ['typescript',  /\b(typescript|node|nodejs)\b/i],
  ['sql',         /\b(sql|postgres|oracle|bigquery|snowflake|cosmosdb)\b/i],
  ['security',    /\b(security|owasp|gdpr|secret|threat|codeql|breach)\b/i],
  ['ai',          /\b(ai|llm|prompt|copilot|agent|mcp|gpt|claude|gemini|arize|phoenix)\b/i],
  ['devops',      /\b(docker|kubernetes|github[-]?action|ci[-]?cd|terraform|deploy|release)\b/i],
  ['testing',     /\b(test|junit|mstest|nunit|tunit|xunit|jest|vitest|playwright|coverage)\b/i],
  ['docs',        /\b(docs|readme|markdown|llms|tldr|tutorial)\b/i],
  ['refactoring', /\b(refactor|simplif|clean|extract)\b/i],
  ['gtm',         /\bgtm[-]/i],
  ['power',       /\b(power[-]?(apps|bi|automate|platform)|dataverse|fabric|flowstudio)\b/i],
  ['design',      /\b(design|figma|drawio|excalidraw|plantuml|fluentui|frontend|uiux)\b/i],
  ['salesforce',  /\b(salesforce|apex)\b/i],
  ['migration',   /\b(migrat|upgrade|convert)\b/i],
]

function inferCategory(slug: string, name: string): string | null {
  const text = `${slug} ${name}`
  for (const [cat, re] of CATEGORY_RULES) {
    if (re.test(text)) return cat
  }
  return null
}

function inferTags(slug: string, name: string, body: string): string[] {
  const tokens = new Set<string>()
  for (const piece of (slug + ' ' + name).split(/[\s\-_/]+/)) {
    const t = piece.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (t.length >= 3 && t.length <= 24) tokens.add(t)
  }
  // Pull code-fence languages from body
  for (const m of body.matchAll(/```([a-z]+)/g)) {
    const lang = (m[1] ?? '').toLowerCase()
    if (lang && lang.length <= 16) tokens.add(lang)
  }
  return [...tokens].slice(0, 12)
}

// ── Ingestion ─────────────────────────────────────────────────────────

export interface IngestOptions {
  workspaceId?: string                 // default 'global'
  sourceRepo?:  string                 // default 'awesome-copilot'
}

export interface IngestResult {
  scanned:   number
  inserted:  number
  updated:   number
  unchanged: number
  errors:    Array<{ path: string; error: string }>
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/skill-library', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function ingestSkillsFromDirectory(
  rootDir: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const workspaceId = opts.workspaceId ?? 'global'
  const sourceRepo  = opts.sourceRepo  ?? 'awesome-copilot'
  const result: IngestResult = { scanned: 0, inserted: 0, updated: 0, unchanged: 0, errors: [] }

  let entries: string[]
  try {
    entries = await readdir(rootDir)
  } catch (e) {
    result.errors.push({ path: rootDir, error: (e as Error).message })
    return result
  }

  for (const slug of entries) {
    const skillDir  = join(rootDir, slug)
    const skillPath = join(skillDir, 'SKILL.md')
    try {
      const s = await stat(skillDir).catch(() => null)
      if (!s || !s.isDirectory()) continue
      const raw = await readFile(skillPath, 'utf8').catch(() => null)
      if (!raw) continue
      result.scanned++

      const parsed   = parseSkillFile(raw, slug)
      const fileHash = createHash('sha256').update(raw).digest('hex').slice(0, 32)
      const category = inferCategory(slug, parsed.name)
      const tags     = inferTags(slug, parsed.name, parsed.body)
      const now      = Date.now()

      const existing = await db.select().from(skillLibrary)
        .where(and(eq(skillLibrary.id, slug), eq(skillLibrary.workspaceId, workspaceId)))
        .limit(1).then(r => r[0]).catch(() => undefined)

      if (existing) {
        if (existing.fileHash === fileHash) {
          result.unchanged++
          continue
        }
        await db.update(skillLibrary)
          .set({
            name:        parsed.name,
            description: parsed.description,
            body:        parsed.body,
            license:     parsed.license,
            category,
            tags,
            fileHash,
            sourcePath:  skillPath,
            updatedAt:   now,
          })
          .where(eq(skillLibrary.id, slug))
          .catch(() => null)
        result.updated++
      } else {
        await db.insert(skillLibrary).values({
          id:          slug,
          workspaceId,
          name:        parsed.name,
          description: parsed.description,
          body:        parsed.body,
          license:     parsed.license,
          sourceRepo,
          sourcePath:  skillPath,
          category,
          tags,
          fileHash,
          useCount:    0,
          lastUsedAt:  null,
          importedAt:  now,
          createdAt:   now,
          updatedAt:   now,
        }).catch((e) => { result.errors.push({ path: skillPath, error: (e as Error).message }) })
        result.inserted++
      }
    } catch (e) {
      result.errors.push({ path: skillPath, error: (e as Error).message })
    }
  }

  await emit(workspaceId, 'skill_library.ingest_completed', {
    sourceRepo, rootDir,
    scanned: result.scanned, inserted: result.inserted,
    updated: result.updated, unchanged: result.unchanged,
    errors: result.errors.length,
  })
  return result
}

// ── Queries ───────────────────────────────────────────────────────────

export async function getSkill(id: string, workspaceId = 'global') {
  return db.select().from(skillLibrary)
    .where(and(eq(skillLibrary.id, id), eq(skillLibrary.workspaceId, workspaceId)))
    .limit(1).then(r => r[0] ?? null).catch(() => null)
}

export async function listSkills(opts: {
  workspaceId?: string
  category?:    string
  q?:           string
  limit?:       number
  sort?:        'used' | 'name' | 'recent'
} = {}) {
  const workspaceId = opts.workspaceId ?? 'global'
  const conds = [eq(skillLibrary.workspaceId, workspaceId)]
  if (opts.category) conds.push(eq(skillLibrary.category, opts.category))
  if (opts.q) {
    const like = `%${opts.q}%`
    const matcher = or(
      ilike(skillLibrary.name, like),
      ilike(skillLibrary.description, like),
      ilike(skillLibrary.id, like),
    )
    if (matcher) conds.push(matcher)
  }
  const order =
      opts.sort === 'name'   ? skillLibrary.name
    : opts.sort === 'recent' ? desc(skillLibrary.updatedAt)
    :                          desc(skillLibrary.useCount)

  return db.select({
    id: skillLibrary.id, name: skillLibrary.name, description: skillLibrary.description,
    license: skillLibrary.license, category: skillLibrary.category, tags: skillLibrary.tags,
    useCount: skillLibrary.useCount, lastUsedAt: skillLibrary.lastUsedAt,
    sourceRepo: skillLibrary.sourceRepo,
  })
    .from(skillLibrary)
    .where(and(...conds))
    .orderBy(order)
    .limit(Math.min(opts.limit ?? 100, 500))
    .catch(() => [])
}

export async function skillCategoryCounts(workspaceId = 'global') {
  const rows = await db.select({
    category: skillLibrary.category,
    count:    sql<number>`COUNT(*)`,
  })
    .from(skillLibrary)
    .where(eq(skillLibrary.workspaceId, workspaceId))
    .groupBy(skillLibrary.category)
    .catch(() => [])
  return rows.map(r => ({ category: r.category, count: Number(r.count) }))
}

/**
 * Bump useCount + lastUsedAt. Call this from any code that injects a
 * skill's body into a prompt or shows it to the operator on purpose.
 */
export async function recordSkillUsage(id: string, workspaceId = 'global') {
  const now = Date.now()
  const row = await db.update(skillLibrary)
    .set({ useCount: sql`${skillLibrary.useCount} + 1`, lastUsedAt: now, updatedAt: now })
    .where(and(eq(skillLibrary.id, id), eq(skillLibrary.workspaceId, workspaceId)))
    .returning()
    .then(r => r[0])
    .catch(() => undefined)
  if (row) await emit(workspaceId, 'skill_library.used', { skillId: id, useCount: row.useCount })
  return row ?? null
}
