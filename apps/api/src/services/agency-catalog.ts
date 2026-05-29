/**
 * agency-catalog.ts — load + sync the agency-agents-main markdown
 * corpus into agent_definitions.
 *
 * Pure helpers (parse / classify / checksum) are exported for unit
 * testing. The DB sync wrapper composes them with disk reads.
 *
 * Each .md file has a YAML frontmatter block:
 *
 *   ---
 *   name: AI Engineer
 *   description: ...
 *   color: blue
 *   emoji: 🤖
 *   vibe: Turns ML models into production features.
 *   ---
 *   # AI Engineer Agent
 *   You are an ...
 *
 * Slugs derive from the filename stem (e.g. engineering-ai-engineer)
 * and the department from the parent directory.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { v7 as uuidv7 } from 'uuid'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentDefinitions } from '../db/schema.js'

export interface ParsedAgent {
  slug:         string
  department:   string
  name:         string
  description:  string | null
  color:        string | null
  emoji:        string | null
  vibe:         string | null
  systemPrompt: string
  sourcePath:   string
  checksum:     string
  tags:         string[]
}

// ─── Pure: frontmatter parser ─────────────────────────────────────────

/**
 * Very small YAML-frontmatter parser. The agency-agents-main corpus
 * uses only flat key:value pairs (no nested objects, no lists), so a
 * full YAML dep is overkill. Returns { meta, body }.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {}
  // Strip BOM if present
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta, body: text }
  const block = m[1] ?? ''
  const body  = m[2] ?? ''
  for (const line of block.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const k = kv[1]!.toLowerCase()
    let v = (kv[2] ?? '').trim()
    // Strip wrapping quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    meta[k] = v
  }
  return { meta, body: body.trim() }
}

/** Derive a stable slug from a filename. */
export function slugFromFilename(filename: string): string {
  return filename
    .replace(/\.md$/i, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .toLowerCase()
}

/**
 * Build a ParsedAgent from a raw markdown file + its location on disk.
 * `sourcePath` should be a path RELATIVE to the agency-agents-main
 * root (e.g. "engineering/engineering-ai-engineer.md") so the catalog
 * stays portable across machines.
 */
export function parseAgentMarkdown(raw: string, relPath: string): ParsedAgent | null {
  const norm = relPath.replace(/\\/g, '/')
  const dir  = path.posix.dirname(norm)
  const file = path.posix.basename(norm)
  if (!file.toLowerCase().endsWith('.md')) return null
  const slug = slugFromFilename(file)
  if (!slug) return null

  const { meta, body } = parseFrontmatter(raw)
  // Name: prefer frontmatter, fall back to humanized slug
  const name = meta['name'] || slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
  // Department: parent directory, or 'misc' if the file lives at root
  const department = dir && dir !== '.' ? dir.split('/').shift()! : 'misc'

  // Body must be substantive — discard README-style stubs
  if (body.length < 80) return null

  const checksum = createHash('sha256').update(raw).digest('hex').slice(0, 16)

  // Extract tags from the body — capture inline "## Skills" / "## Capabilities"
  // bullets if present. Pure regex extraction so the parser stays sync.
  const tags: string[] = []
  const tagBlock = /##\s+(?:skills|capabilities|expertise|focus)[^\n]*\n([\s\S]*?)(?=\n##|\n#|$)/i.exec(body)
  if (tagBlock) {
    for (const m of tagBlock[1]!.matchAll(/^\s*[-*]\s+(.+)$/gm)) {
      const t = m[1]!.replace(/[*_`]/g, '').trim().toLowerCase()
      if (t.length > 0 && t.length < 60) tags.push(t)
      if (tags.length >= 10) break
    }
  }

  return {
    slug, department, name,
    description:  meta['description']  ?? null,
    color:        meta['color']        ?? null,
    emoji:        meta['emoji']        ?? null,
    vibe:         meta['vibe']         ?? null,
    systemPrompt: body,
    sourcePath:   norm,
    checksum,
    tags,
  }
}

// ─── Pure: department-aware picker ────────────────────────────────────

const DEPARTMENT_KEYWORDS: Record<string, string[]> = {
  engineering:      ['code', 'bug', 'api', 'backend', 'frontend', 'database', 'devops', 'refactor', 'deploy', 'test', 'lint', 'typescript', 'python', 'rust', 'go'],
  design:           ['design', 'ui', 'ux', 'figma', 'icon', 'logo', 'brand', 'mockup', 'prototype', 'visual', 'layout'],
  marketing:        ['marketing', 'campaign', 'seo', 'content', 'social', 'tiktok', 'instagram', 'youtube', 'newsletter', 'growth', 'audience', 'copy'],
  'paid-media':     ['ads', 'ppc', 'meta ads', 'google ads', 'paid', 'cpa', 'roas', 'creative test', 'budget allocation'],
  sales:            ['sales', 'pitch', 'outreach', 'cold email', 'discovery', 'demo', 'close', 'deal', 'lead', 'prospect', 'crm'],
  finance:          ['finance', 'invoice', 'budget', 'forecast', 'p&l', 'cashflow', 'tax', 'accounting', 'pricing'],
  product:          ['product', 'feature', 'roadmap', 'spec', 'prd', 'requirement', 'user story'],
  'project-management': ['project', 'sprint', 'standup', 'milestone', 'kanban', 'jira', 'planning', 'estimate'],
  strategy:         ['strategy', 'vision', 'positioning', 'market', 'competitor', 'okr', 'thesis'],
  support:          ['support', 'ticket', 'help desk', 'customer issue', 'escalation', 'refund', 'churn'],
  testing:          ['test', 'qa', 'regression', 'load test', 'e2e', 'unit test', 'coverage'],
  academic:         ['paper', 'cite', 'research paper', 'literature', 'thesis review', 'peer review'],
  'game-development': ['game', 'unity', 'unreal', 'gameplay', 'level', 'shader'],
  'spatial-computing': ['ar', 'vr', 'xr', 'vision pro', 'spatial', 'hand tracking'],
  integrations:     ['integration', 'webhook', 'oauth', 'zapier', 'connector', 'sync'],
  specialized:      [],
  examples:         [],
  scripts:          [],
}

export interface PickerInput {
  task:         string
  hint?:        string         // operator-supplied department or slug hint
  catalog:      Array<Pick<ParsedAgent, 'slug' | 'department' | 'name' | 'description' | 'tags' | 'vibe'>>
}

export interface PickerResult {
  slug:        string
  department:  string
  score:       number
  reason:      string
}

/**
 * Score each catalog agent against the task and return the best match.
 * Returns null when nothing scores meaningfully (caller should fall
 * back to a generalist or ask the operator for direction).
 */
export function pickAgent(input: PickerInput): PickerResult | null {
  const task = input.task.toLowerCase()
  const hint = input.hint?.toLowerCase().trim() ?? ''
  if (!task) return null

  // Direct slug hint wins outright
  if (hint) {
    const exact = input.catalog.find(c => c.slug === hint)
    if (exact) return { slug: exact.slug, department: exact.department, score: 1, reason: 'operator hint matched slug' }
  }

  // Department keyword scoring
  const deptScores: Record<string, number> = {}
  for (const [dept, words] of Object.entries(DEPARTMENT_KEYWORDS)) {
    let s = 0
    for (const w of words) if (task.includes(w)) s += 1
    if (hint && dept === hint) s += 5
    if (s > 0) deptScores[dept] = s
  }
  const topDept = Object.entries(deptScores).sort((a, b) => b[1] - a[1])[0]

  // Score individual agents — tag + name + vibe overlap with the task
  let best: { item: PickerInput['catalog'][number]; score: number } | null = null
  for (const a of input.catalog) {
    let score = 0
    if (topDept && a.department === topDept[0]) score += topDept[1] * 1.5
    const blob = [
      a.name.toLowerCase(),
      (a.description ?? '').toLowerCase(),
      (a.vibe ?? '').toLowerCase(),
      ...(a.tags ?? []),
    ].join(' ')
    // Reward word overlap (bag-of-words, small lexicon)
    for (const word of task.split(/\W+/).filter(w => w.length > 3)) {
      if (blob.includes(word)) score += 1
    }
    if (!best || score > best.score) best = { item: a, score }
  }
  if (!best || best.score < 2) return null
  return {
    slug:       best.item.slug,
    department: best.item.department,
    score:      best.score,
    reason:     topDept ? `department=${topDept[0]} keyword score ${topDept[1]} + agent overlap` : 'agent overlap',
  }
}

// ─── DB sync ───────────────────────────────────────────────────────────

export interface SyncResult {
  scanned:  number
  inserted: number
  updated:  number
  skipped:  number
  errors:   Array<{ path: string; error: string }>
}

/**
 * Recursively walk `root`, parse every .md (skipping README/CONTRIBUTING/
 * SECURITY/LICENSE), upsert into agent_definitions. Idempotent — uses
 * checksum to skip unchanged rows.
 */
export async function syncAgentCatalog(workspaceId: string, root: string): Promise<SyncResult> {
  const result: SyncResult = { scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: [] }

  // Walk the tree, depth-first
  async function walk(dir: string): Promise<string[]> {
    const out: string[] = []
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) out.push(...(await walk(full)))
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full)
    }
    return out
  }

  const SKIP_NAMES = new Set(['readme.md', 'contributing.md', 'contributing_zh-cn.md', 'security.md', 'license.md'])
  const files = await walk(root)
  for (const abs of files) {
    const base = path.basename(abs).toLowerCase()
    if (SKIP_NAMES.has(base)) { result.skipped++; continue }
    result.scanned++
    try {
      const raw = await readFile(abs, 'utf8')
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      const parsed = parseAgentMarkdown(raw, rel)
      if (!parsed) { result.skipped++; continue }

      // Read current row for change-detection (counts only). The actual
      // write is an atomic upsert on the (workspace_id, slug) unique index
      // — replaces the prior SELECT-then-INSERT/UPDATE that could race two
      // concurrent catalog scans into a duplicate-key crash.
      const existing = await db.select({ checksum: agentDefinitions.checksum })
        .from(agentDefinitions)
        .where(and(eq(agentDefinitions.workspaceId, workspaceId), eq(agentDefinitions.slug, parsed.slug)))
        .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[agency-catalog]', e.message); return null })

      const now = Date.now()
      if (existing && existing.checksum === parsed.checksum) {
        result.skipped++
      } else {
        const mutable = {
          department:   parsed.department,
          name:         parsed.name,
          description:  parsed.description,
          color:        parsed.color,
          emoji:        parsed.emoji,
          vibe:         parsed.vibe,
          systemPrompt: parsed.systemPrompt,
          sourcePath:   parsed.sourcePath,
          checksum:     parsed.checksum,
          tags:         parsed.tags,
          updatedAt:    now,
        }
        await db.insert(agentDefinitions).values({
          id: uuidv7(),
          workspaceId,
          slug: parsed.slug,
          createdAt: now,
          ...mutable,
        }).onConflictDoUpdate({
          target: [agentDefinitions.workspaceId, agentDefinitions.slug],
          set: mutable,
        }).catch((e: unknown) => {
          console.error('[agency-catalog] upsert failed for', parsed.slug, (e as Error).message)
        })
        if (existing) result.updated++
        else result.inserted++
      }
    } catch (e) {
      result.errors.push({ path: abs, error: (e as Error).message })
    }
  }
  return result
}

/** Quick directory existence + count, used by the sync route. */
export async function describeCatalogRoot(root: string): Promise<{ exists: boolean; mdCount: number }> {
  try {
    const s = await stat(root)
    if (!s.isDirectory()) return { exists: false, mdCount: 0 }
  } catch { return { exists: false, mdCount: 0 } }
  // Cheap recursive count
  async function count(dir: string): Promise<number> {
    let n = 0
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return 0 }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) n += await count(full)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n++
    }
    return n
  }
  return { exists: true, mdCount: await count(root) }
}
