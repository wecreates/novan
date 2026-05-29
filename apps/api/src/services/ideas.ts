/**
 * ideas.ts — personal-intelligence-to-product pipeline.
 *
 * Three concerns, kept in one file because they're one workflow:
 *
 *   1. EXTRACT — given a blob of text (chat export, notes, file, paste),
 *      produce N typed Idea drafts. Heuristic-first (works offline, no
 *      LLM dependency); enrichment via LLM is a separate optional path.
 *
 *   2. LEDGER — CRUD + status transitions on persisted ideas.
 *      Lifecycle: raw → clarified → validated → blueprinted → promoted
 *                                                          | archived | rejected
 *
 *   3. PROMOTE — convert a blueprinted idea into a real business by
 *      calling the existing constructBusiness() service. The idea row
 *      keeps its source history; the business row carries forward the
 *      title + brief.
 *
 * Honest scope:
 *   - The extractor uses pattern matching, not an LLM. It catches the
 *     common shapes ("build a X", "tool for Y", bullet lists of features,
 *     numbered idea blocks) and emits drafts with as many fields filled
 *     as the text supports. Operator edits the rest.
 *   - Dedup is by fingerprint (normalized title+category). Embedding-
 *     based semantic dedup is a separate improvement.
 */
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { ideas, events } from '../db/schema.js'
import { constructBusiness } from './business-construction.js'

// ── Types ─────────────────────────────────────────────────────────────

export type IdeaStatus =
  | 'raw' | 'clarified' | 'validated' | 'blueprinted'
  | 'promoted' | 'archived' | 'rejected'

export type IdeaCategory =
  | 'saas' | 'website' | 'tool' | 'extension' | 'content'
  | 'commerce' | 'service' | 'ai-tool' | 'other'

export type IdeaSourceType =
  | 'chat' | 'file' | 'note' | 'paste' | 'manual' | 'chat-import'

export interface IdeaDraft {
  title:         string
  raw:           string
  category?:     IdeaCategory
  targetUser?:   string
  painPoint?:    string
  solution?:     string
  features?:     string[]
  monetization?: string
  techStack?:    string[]
  sourceExcerpt?: string
}

// ── Heuristic extraction ──────────────────────────────────────────────

const CATEGORY_PATTERNS: Array<[IdeaCategory, RegExp]> = [
  ['extension',  /\b(chrome\s+extension|browser\s+extension|firefox\s+add[\s-]?on)\b/i],
  ['ai-tool',    /\b(ai\s+(tool|app|assistant|agent|wrapper)|llm\s+(tool|app|wrapper)|gpt\s+(tool|app))\b/i],
  ['saas',       /\b(saas|subscription\s+(app|tool|product|service)|b2b\s+(tool|app|product))\b/i],
  ['commerce',   /\b(e[\s-]?commerce|shopify|print[\s-]?on[\s-]?demand|pod\s+(store|shop)|merch)\b/i],
  ['content',    /\b(newsletter|blog|content\s+(site|business)|youtube\s+channel|podcast)\b/i],
  ['website',    /\b(landing\s+page|marketing\s+site|portfolio\s+site|directory)\b/i],
  ['service',    /\b(agency|freelance|consulting|done[\s-]?for[\s-]?you)\b/i],
  ['tool',       /\b(tool|utility|widget|helper|generator)\b/i],
]

const IDEA_LEAD_PATTERNS = [
  // "build a/an X that ..."
  /\b(?:build|make|create|launch|ship|design)\s+(?:a|an|the)?\s+([A-Z]?[a-z][^.!?\n]{6,120})/g,
  // "X for Y" / "X that lets Y do Z"
  /\b(?:tool|app|site|platform|product|service|saas|extension)\s+(?:that|for|to)\s+([^.!?\n]{10,160})/gi,
  // "idea: ..."
  /\bidea(?:\s*\#?\d*)?[:\-—]\s*([^.!?\n]{6,200})/gi,
  // Numbered list "1. ..." with at least one verb
  /^\s*\d+[.)]\s+([A-Za-z][^.!?\n]{10,200}(?:build|launch|create|make|automate|generate|track|manage)[^.!?\n]{0,80})/gim,
]

const FEATURE_BULLET = /^[\s]*[-*•]\s+([A-Z][^.!?\n]{4,140})/gm
const MONETIZATION_PATTERNS = [
  /\bmonet[ia]z(?:e|ation)[:\-—]?\s*([^.!?\n]{4,160})/i,
  /\b(?:revenue|pricing|subscription|one[\s-]?time|usage[\s-]?based|freemium|ads|affiliate)\b[^.!?\n]{0,120}/i,
  /\$\s*\d+(?:[\s/]\s*(?:mo|month|yr|year|user))?/i,
]
const PAIN_PATTERNS = [
  /\b(?:problem|pain|frustrat\w+|annoy\w+|tedious|manual|slow|broken|hard\s+to|wish\s+(?:there|i\s+had))[:\s\-—]([^.!?\n]{8,200})/i,
]
const USER_PATTERNS = [
  /\bfor\s+(?:people|users|teams|companies|founders|developers|designers|writers|creators)\s+(?:who|that|wanting)\s+([^.!?\n]{6,160})/i,
]

function detectCategory(text: string): IdeaCategory | undefined {
  for (const [cat, re] of CATEGORY_PATTERNS) if (re.test(text)) return cat
  return undefined
}

function normalizeTitle(raw: string): string {
  // First clause, capitalized, trimmed, max 100 chars
  const first = raw.split(/[.!?\n]/)[0] ?? raw
  const trim  = first.trim().replace(/\s+/g, ' ').slice(0, 100)
  if (trim.length < 6) return ''
  return trim[0]!.toUpperCase() + trim.slice(1)
}

function fingerprint(title: string, category: string | undefined): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim()
  const key  = `${category ?? 'unknown'}::${norm.slice(0, 80)}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function around(text: string, idx: number, span = 250): string {
  const start = Math.max(0, idx - span)
  const end   = Math.min(text.length, idx + span)
  return text.slice(start, end).replace(/\s+/g, ' ').trim()
}

/**
 * Extract idea drafts from a blob of text. Returns empty array if no
 * recognizable patterns matched — that's an honest signal that the
 * text wasn't structured enough for heuristic extraction, not a failure.
 *
 * Drafts include duplicates by title; the persistence layer dedupes
 * via fingerprint.
 */
export function extractIdeaDrafts(text: string): IdeaDraft[] {
  if (!text || text.length < 20) return []
  const drafts: IdeaDraft[] = []
  const seenTitles = new Set<string>()

  // Collect candidates from lead patterns
  for (const re of IDEA_LEAD_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const snippet = (m[1] ?? '').trim()
      const title   = normalizeTitle(snippet)
      if (!title || seenTitles.has(title.toLowerCase())) continue
      seenTitles.add(title.toLowerCase())

      const excerpt  = around(text, m.index)
      const category = detectCategory(snippet + ' ' + excerpt)

      // Features: bullet points near the match
      const features: string[] = []
      FEATURE_BULLET.lastIndex = 0
      const bulletWindow = text.slice(m.index, Math.min(text.length, m.index + 800))
      let b: RegExpExecArray | null
      while ((b = FEATURE_BULLET.exec(bulletWindow)) !== null && features.length < 8) {
        features.push((b[1] ?? '').trim().slice(0, 140))
      }

      // Monetization in window
      let monetization: string | undefined
      for (const p of MONETIZATION_PATTERNS) {
        const mm = excerpt.match(p)
        if (mm) { monetization = (mm[1] ?? mm[0]).trim().slice(0, 200); break }
      }

      // Pain / target user
      let painPoint: string | undefined
      for (const p of PAIN_PATTERNS) {
        const pm = excerpt.match(p)
        if (pm) { painPoint = (pm[1] ?? pm[0]).trim().slice(0, 240); break }
      }
      let targetUser: string | undefined
      for (const p of USER_PATTERNS) {
        const um = excerpt.match(p)
        if (um) { targetUser = (um[1] ?? '').trim().slice(0, 160); break }
      }

      drafts.push({
        title,
        raw:           snippet,
        ...(category     ? { category }     : {}),
        ...(targetUser   ? { targetUser }   : {}),
        ...(painPoint    ? { painPoint }    : {}),
        ...(monetization ? { monetization } : {}),
        ...(features.length > 0 ? { features } : {}),
        sourceExcerpt: excerpt,
      })
    }
  }

  return drafts
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: (payload['ideaId'] as string) ?? uuidv7(),
    causationId: null, source: 'api/ideas', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[ideas]', e.message); return null })
}

// ── Persistence ───────────────────────────────────────────────────────

export interface CreateIdeaInput extends IdeaDraft {
  workspaceId: string
  sourceType:  IdeaSourceType
  sourceRef?:  string
  createdBy?:  string
}

/**
 * Insert an idea OR return the existing one if fingerprint matches.
 * Returns { idea, created: boolean }.
 */
export async function createOrDedupeIdea(input: CreateIdeaInput) {
  const fp = fingerprint(input.title, input.category)
  const existing = await db.select().from(ideas)
    .where(and(
      eq(ideas.workspaceId, input.workspaceId),
      eq(ideas.fingerprint, fp),
      inArray(ideas.status, ['raw', 'clarified', 'validated', 'blueprinted']),
    ))
    .limit(1).then(r => r[0]).catch(() => undefined)

  if (existing) return { idea: existing, created: false }

  const now = Date.now()
  const row = {
    id:               uuidv7(),
    workspaceId:      input.workspaceId,
    title:            input.title,
    raw:              input.raw,
    fingerprint:      fp,
    category:         input.category ?? null,
    targetUser:       input.targetUser ?? null,
    painPoint:        input.painPoint ?? null,
    solution:         input.solution ?? null,
    features:         input.features ?? [],
    monetization:     input.monetization ?? null,
    techStack:        input.techStack ?? [],
    demandScore:      null,
    difficultyScore:  null,
    buildReadiness:   null,
    upsideScore:      null,
    riskScore:        null,
    sourceType:       input.sourceType,
    sourceRef:        input.sourceRef ?? null,
    sourceExcerpt:    input.sourceExcerpt ?? null,
    status:           'raw' as const,
    promotedToBusinessId: null,
    promotedAt:       null,
    archivedAt:       null,
    rejectedReason:   null,
    createdBy:        input.createdBy ?? 'system',
    createdAt:        now,
    updatedAt:        now,
  }
  const inserted = await db.insert(ideas).values(row).returning().then(r => r[0]).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[ideas] insert failed:', (e as Error).message)
    return undefined
  })
  if (!inserted) throw new Error('failed to create idea')

  await emit(input.workspaceId, 'idea.created', {
    ideaId: inserted.id, title: inserted.title, category: inserted.category, source: input.sourceType,
  })
  return { idea: inserted, created: true }
}

/**
 * Extract from text + persist + dedup. Returns counts plus the rows.
 */
export async function ingestText(
  workspaceId: string, text: string,
  source: { type: IdeaSourceType; ref?: string; createdBy?: string },
) {
  const drafts = extractIdeaDrafts(text)
  const created: typeof ideas.$inferSelect[] = []
  const deduped: typeof ideas.$inferSelect[] = []
  for (const d of drafts) {
    const r = await createOrDedupeIdea({
      workspaceId,
      ...d,
      sourceType: source.type,
      ...(source.ref       ? { sourceRef: source.ref } : {}),
      ...(source.createdBy ? { createdBy: source.createdBy } : {}),
    }).catch((e: Error) => { console.error('[ideas]', e.message); return null })
    if (!r) continue
    if (r.created) created.push(r.idea); else deduped.push(r.idea)
  }
  await emit(workspaceId, 'ideas.ingest_completed', {
    extracted: drafts.length, created: created.length, deduped: deduped.length,
    sourceType: source.type, ...(source.ref ? { sourceRef: source.ref } : {}),
  })
  return { extracted: drafts.length, created, deduped }
}

// ── Status transitions ────────────────────────────────────────────────

async function setStatus(
  workspaceId: string, id: string, status: IdeaStatus,
  patch: Partial<typeof ideas.$inferInsert> = {},
) {
  const now = Date.now()
  const row = await db.update(ideas)
    .set({ status, ...patch, updatedAt: now })
    .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, `idea.${status}`, { ideaId: id })
  return row
}

export const clarifyIdea   = (ws: string, id: string, patch: Partial<typeof ideas.$inferInsert>) => setStatus(ws, id, 'clarified',   patch)
export const validateIdea  = (ws: string, id: string, patch: Partial<typeof ideas.$inferInsert>) => setStatus(ws, id, 'validated',   patch)
export const blueprintIdea = (ws: string, id: string, patch: Partial<typeof ideas.$inferInsert>) => setStatus(ws, id, 'blueprinted', patch)
export const archiveIdea   = (ws: string, id: string) => setStatus(ws, id, 'archived', { archivedAt: Date.now() })
export const rejectIdea    = (ws: string, id: string, reason: string) => setStatus(ws, id, 'rejected', { rejectedReason: reason, archivedAt: Date.now() })

export async function updateIdea(
  workspaceId: string, id: string,
  patch: Partial<Pick<typeof ideas.$inferInsert,
    'title'|'category'|'targetUser'|'painPoint'|'solution'|'features'|'monetization'|'techStack'|
    'demandScore'|'difficultyScore'|'buildReadiness'|'upsideScore'|'riskScore'>>,
) {
  const now = Date.now()
  const row = await db.update(ideas)
    .set({ ...patch, updatedAt: now })
    .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)))
    .returning().then(r => r[0]).catch(() => undefined)
  if (!row) return null
  await emit(workspaceId, 'idea.updated', { ideaId: id, fields: Object.keys(patch) })
  return row
}

// ── Promotion ─────────────────────────────────────────────────────────

/**
 * Promote an idea → real business. Builds a brief from the idea fields
 * and calls the existing constructBusiness() service. Links back.
 *
 * Requires status === 'blueprinted' OR force=true. This is the same
 * "no fixed without evidence" pattern as the issues ledger: you can't
 * skip clarification → validation → blueprint and go straight to live
 * spawning unless you explicitly override.
 */
export async function promoteIdea(workspaceId: string, ideaId: string, opts: { force?: boolean } = {}) {
  const idea = await db.select().from(ideas)
    .where(and(eq(ideas.id, ideaId), eq(ideas.workspaceId, workspaceId)))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (!idea) return null

  if (idea.status === 'promoted')      return { idea, business: null as unknown, alreadyPromoted: true }
  if (idea.status === 'archived' || idea.status === 'rejected') {
    throw new Error(`cannot promote idea in terminal status '${idea.status}'`)
  }
  if (idea.status !== 'blueprinted' && !opts.force) {
    throw new Error(`cannot promote idea: status is '${idea.status}', not 'blueprinted' (pass force to override)`)
  }

  // Build a brief from idea fields. Empty fields are skipped so the
  // constructBusiness archetype matcher gets the most informative text.
  const briefParts: string[] = [idea.title]
  if (idea.solution)     briefParts.push(`Solution: ${idea.solution}`)
  if (idea.painPoint)    briefParts.push(`Pain: ${idea.painPoint}`)
  if (idea.targetUser)   briefParts.push(`For: ${idea.targetUser}`)
  if (idea.monetization) briefParts.push(`Monetization: ${idea.monetization}`)
  const features = (idea.features as string[] | null) ?? []
  if (features.length > 0) briefParts.push(`Features: ${features.slice(0, 5).join('; ')}`)
  const brief = briefParts.join('. ').slice(0, 1900)

  const result = await constructBusiness({ workspaceId, brief, name: idea.title })
  const businessId = result.businessId

  const now = Date.now()
  const updated = await db.update(ideas)
    .set({
      status:               'promoted',
      promotedToBusinessId: businessId,
      promotedAt:           now,
      updatedAt:            now,
    })
    .where(eq(ideas.id, ideaId))
    .returning().then(r => r[0]).catch(() => idea)

  await emit(workspaceId, 'idea.promoted', { ideaId, businessId, brief: brief.slice(0, 200) })
  return { idea: updated ?? idea, business: result, alreadyPromoted: false }
}

// ── Queries ───────────────────────────────────────────────────────────

export async function getIdea(workspaceId: string, id: string) {
  return db.select().from(ideas)
    .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)))
    .limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[ideas]', e.message); return null })
}

export async function listIdeas(
  workspaceId: string,
  opts: { status?: IdeaStatus; category?: IdeaCategory; limit?: number } = {},
) {
  const conds = [eq(ideas.workspaceId, workspaceId)]
  if (opts.status)   conds.push(eq(ideas.status,   opts.status))
  if (opts.category) conds.push(eq(ideas.category, opts.category))
  return db.select().from(ideas)
    .where(and(...conds))
    .orderBy(desc(ideas.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500))
    .catch(() => [])
}

export async function ideaStats(workspaceId: string) {
  const rows = await db.select({
    status:   ideas.status,
    category: ideas.category,
    count:    sql<number>`COUNT(*)`,
  })
    .from(ideas)
    .where(eq(ideas.workspaceId, workspaceId))
    .groupBy(ideas.status, ideas.category)
    .catch(() => [])
  return rows.map(r => ({ status: r.status, category: r.category, count: Number(r.count) }))
}
