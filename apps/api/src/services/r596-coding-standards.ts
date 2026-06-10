/**
 * R596 — Coding Standards registry (Agent-OS-inspired).
 *
 * GAP closed: Novan's R193 self-dev pipeline generates code with no codified
 * project conventions to constrain it. Builder.io's Agent OS solves this with
 * a standards/ folder + index.yml + auto-injection of relevant standards into
 * the agent's context for the current task.
 *
 * R596 ports that idea into Novan's runtime:
 *   - coding_standards table (workspace-scoped)
 *   - detection by file-glob + keyword overlap
 *   - injection helpers that R215 brain-loop + R193 selfdev call to surface
 *     relevant standards in the LLM system prompt
 *   - seed function with 6 starter standards extracted from Novan's existing
 *     idioms (already documented in CLAUDE.md but not queryable by agents)
 *
 * Detection is intentionally lightweight: a substring glob match + a keyword
 * Jaccard score against the body. No full semantic search — that's R582's
 * job and the two are complementary.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS coding_standards (
      workspace_id        TEXT NOT NULL,
      slug                TEXT NOT NULL,
      category            TEXT NOT NULL DEFAULT 'global',
      title               TEXT NOT NULL,
      body                TEXT NOT NULL,
      detection_globs     JSONB NOT NULL DEFAULT '[]'::jsonb,
      detection_keywords  JSONB NOT NULL DEFAULT '[]'::jsonb,
      importance          INT NOT NULL DEFAULT 50,
      updated_at          BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, slug)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS coding_standards_ws_cat_idx ON coding_standards (workspace_id, category)`).catch(() => {})
}

export interface CodingStandard {
  slug:              string
  category:          string
  title:             string
  body:              string
  detectionGlobs:    string[]
  detectionKeywords: string[]
  importance:        number
  updatedAt:         number
}

export async function upsertStandard(workspaceId: string, s: Omit<CodingStandard, 'updatedAt'>): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    INSERT INTO coding_standards (workspace_id, slug, category, title, body, detection_globs, detection_keywords, importance, updated_at)
    VALUES (${workspaceId}, ${s.slug}, ${s.category}, ${s.title}, ${s.body},
            ${JSON.stringify(s.detectionGlobs)}::jsonb, ${JSON.stringify(s.detectionKeywords)}::jsonb,
            ${s.importance}, ${Date.now()})
    ON CONFLICT (workspace_id, slug) DO UPDATE SET
      category           = EXCLUDED.category,
      title              = EXCLUDED.title,
      body               = EXCLUDED.body,
      detection_globs    = EXCLUDED.detection_globs,
      detection_keywords = EXCLUDED.detection_keywords,
      importance         = EXCLUDED.importance,
      updated_at         = EXCLUDED.updated_at
  `).catch(() => {})
}

export async function listStandards(workspaceId: string, category?: string): Promise<CodingStandard[]> {
  await ensureTable()
  const rows = category
    ? await db.execute(sql`SELECT * FROM coding_standards WHERE workspace_id = ${workspaceId} AND category = ${category} ORDER BY importance DESC, slug ASC`)
    : await db.execute(sql`SELECT * FROM coding_standards WHERE workspace_id = ${workspaceId} ORDER BY importance DESC, slug ASC`)
  return (rows as unknown as Array<{ slug: string; category: string; title: string; body: string; detection_globs: string[]; detection_keywords: string[]; importance: number; updated_at: number }>)
    .map(r => ({
      slug: r.slug, category: r.category, title: r.title, body: r.body,
      detectionGlobs: r.detection_globs ?? [], detectionKeywords: r.detection_keywords ?? [],
      importance: Number(r.importance), updatedAt: Number(r.updated_at),
    }))
}

/** Tiny glob match: `*` = any segment, `**` = any path. Substring-style for speed. */
function globMatch(glob: string, path: string): boolean {
  if (!glob || !path) return false
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '<<DSTAR>>').replace(/\*/g, '[^/]*').replace(/<<DSTAR>>/g, '.*')
  return new RegExp('^' + esc + '$').test(path)
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9_./\-]+/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && w.length <= 32),
  )
}

export interface ApplicableInput {
  filePath?:    string
  opName?:      string
  description?: string
  keywords?:    string[]
}

export interface ApplicableHit {
  standard: CodingStandard
  score:    number     // 0..1 — combined glob + keyword score
  reason:   string
}

/** Score each standard against the input. Glob hit = +0.6, keyword Jaccard = +0.4. */
export async function applicableStandards(workspaceId: string, input: ApplicableInput, max = 5): Promise<ApplicableHit[]> {
  const all = await listStandards(workspaceId)
  const haystack = [input.filePath ?? '', input.opName ?? '', input.description ?? '', (input.keywords ?? []).join(' ')].join(' ')
  const inputTokens = tokenize(haystack)
  const hits: ApplicableHit[] = []
  for (const s of all) {
    let score = 0
    let reasons: string[] = []
    if (input.filePath) {
      for (const g of s.detectionGlobs) {
        if (globMatch(g, input.filePath)) { score += 0.6; reasons.push(`glob:${g}`); break }
      }
    }
    if (s.detectionKeywords.length > 0) {
      const stdTokens = new Set(s.detectionKeywords.map(k => k.toLowerCase()))
      let overlap = 0
      for (const t of stdTokens) if (inputTokens.has(t)) overlap++
      if (overlap > 0) {
        const jaccard = overlap / (stdTokens.size + inputTokens.size - overlap)
        score += 0.4 * jaccard
        reasons.push(`kw:${overlap}/${stdTokens.size}`)
      }
    }
    // Importance nudges ties: +0.05 max for importance 100.
    score += (s.importance / 100) * 0.05
    if (score > 0) hits.push({ standard: s, score: Math.min(1, score), reason: reasons.join(',') || 'importance' })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, max)
}

/** Render applicable standards as a markdown block to inject into LLM system prompt. */
export function buildStandardsBlock(hits: ApplicableHit[]): string {
  if (hits.length === 0) return ''
  const lines: string[] = ['<!-- R596 coding standards (applicable to this task) -->']
  for (const h of hits) {
    lines.push(`## ${h.standard.title}  [${h.standard.slug}]`)
    lines.push(h.standard.body.trim())
    lines.push('')
  }
  return lines.join('\n')
}

/** Seed 6 starter standards extracted from CLAUDE.md/existing Novan idioms.
 *  Idempotent via ON CONFLICT. Safe to re-run after edits — operator owns
 *  the body, the seed only inserts if missing. */
export async function seedStarterStandards(workspaceId: string): Promise<{ inserted: number; skipped: number }> {
  await ensureTable()
  const existing = new Set((await listStandards(workspaceId)).map(s => s.slug))
  const starters: Array<Omit<CodingStandard, 'updatedAt'>> = [
    {
      slug: 'patch-not-rewrite',
      category: 'global',
      title: 'Patch, never rewrite',
      body: 'When modifying existing files, emit the smallest diff that fixes the bug or adds the feature. Never regenerate an entire file for a small change. Edit tool > Write tool. Multi-edit batching > sequential Edits. Preserve unrelated formatting, ordering, and comments.',
      detectionGlobs: ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts'],
      detectionKeywords: ['edit', 'modify', 'patch', 'fix', 'refactor', 'update'],
      importance: 90,
    },
    {
      slug: 'sql-tolerated-catch',
      category: 'database',
      title: 'Tolerated catches on dynamic DDL',
      body: 'Service-side `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` calls must be wrapped in `.catch(() => {})` so a race with another booting instance is non-fatal. For data-path queries (SELECT/INSERT/UPDATE), DO NOT swallow errors — surface them so the caller can decide.',
      detectionGlobs: ['apps/api/src/services/*.ts'],
      detectionKeywords: ['createtable', 'createindex', 'ensuretable', 'ddl', 'migration', 'schema'],
      importance: 85,
    },
    {
      slug: 'business-scoped-tables',
      category: 'database',
      title: 'Per-business tables use NULLABLE business_id',
      body: 'New tables that may be per-business MUST add `business_id TEXT NULL` and a partial composite index `(workspace_id, business_id, ...)` WHERE business_id IS NOT NULL. NULL means workspace-level (legacy path). Never make business_id NOT NULL — breaks backward compat. See migration 0122 for the pattern.',
      detectionGlobs: ['apps/api/src/services/*.ts', 'packages/db/migrations/*.sql'],
      detectionKeywords: ['business_id', 'businessid', 'multibusiness', 'per-business', 'fanout', 'workspace'],
      importance: 85,
    },
    {
      slug: 'brain-op-shape',
      category: 'brain',
      title: 'Brain op shape: description + risk + handler',
      body: 'New brain ops in `apps/api/src/services/brain-task.ts` follow this exact shape:\n\n```ts\n\'category.action\': {\n  description: \'Rxxx: One-line. Params: foo, bar?\',\n  risk: \'low\' | \'medium\' | \'high\',\n  handler: async (ws, params) => { ... },\n},\n```\n\nThe op name MUST appear in `INFO_OPS_NO_OUTPUT_GUARD` if it returns no chat-renderable output, and in the admin allowlist if it should be callable via /admin/brain. Risk gates ACL (R585) and hooks (R576).',
      detectionGlobs: ['apps/api/src/services/brain-task.ts'],
      detectionKeywords: ['op', 'brainop', 'operations', 'handler', 'risk', 'description'],
      importance: 95,
    },
    {
      slug: 'advisory-lock-cron-keys',
      category: 'cron',
      title: 'Cron advisory locks key on (cronName, businessId)',
      body: 'Per-business cron fan-out (R587 `runForEachBusiness`) acquires `withCronLock(`${cronName}|${businessId}`, fn)` so concurrent ticks across replicas can\'t double-write the same (cron, biz) pair. Workspace-only ticks lock on `cronName` alone. Never call work-loop bodies without a lock — R504 advisory locks are mandatory.',
      detectionGlobs: ['apps/api/src/services/learning-cron.ts', 'apps/api/src/services/r587-*.ts'],
      detectionKeywords: ['cron', 'lock', 'advisorylock', 'scheduled', 'tick', 'fanout'],
      importance: 85,
    },
    {
      slug: 'no-silent-failure',
      category: 'global',
      title: 'No silent failure on data paths',
      body: 'Empty catch blocks `catch { }` are only acceptable for: (1) DDL races (CREATE IF NOT EXISTS), (2) best-effort telemetry inserts, (3) audit log writes. For ANY data fetch or mutation the user depends on, surface the error — return `{ ok: false, reason }` or throw. Silent failure on payments, email send, embedding fetch, etc. is a defect.',
      detectionGlobs: ['apps/**/*.ts'],
      detectionKeywords: ['catch', 'error', 'failure', 'silent', 'swallowed', 'tolerated'],
      importance: 90,
    },
  ]
  let inserted = 0, skipped = 0
  for (const s of starters) {
    if (existing.has(s.slug)) { skipped++; continue }
    await upsertStandard(workspaceId, s)
    inserted++
  }
  return { inserted, skipped }
}
