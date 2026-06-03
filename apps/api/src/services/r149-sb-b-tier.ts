/**
 * R146.149 — SB B-tier 11-15: decision journal, idea incubator,
 * Q&A pairs as memory, concept maturity, knowledge search operators.
 */
import { db } from '../db/client.js'
import { decisions, ideasIncubator, qaPairs, conceptMaturity, memoryChunks, memoryTags, dailyNotes } from '../db/schema.js'
import { and, eq, desc, gte, lte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000

// ─── #11 — Decision journal ──────────────────────────────────────────

export async function decisionLog(workspaceId: string, opts: {
  question: string
  reasoning: string
  expectedOutcome?: string
  alternatives?: string[]
  confidence?: number
  reviewInDays?: number
}): Promise<{ id: string; reviewAt: number }> {
  const id = uuidv7()
  const reviewAt = Date.now() + (opts.reviewInDays ?? 30) * DAY_MS
  await db.insert(decisions).values({
    id, workspaceId,
    question: opts.question.slice(0, 2000),
    reasoning: opts.reasoning.slice(0, 8000),
    expectedOutcome: opts.expectedOutcome ?? null,
    alternatives: (opts.alternatives ?? []).slice(0, 10),
    confidence: Math.max(0, Math.min(opts.confidence ?? 0.5, 1)),
    reviewAt,
    decidedAt: Date.now(),
  })
  return { id, reviewAt }
}

export async function decisionReview(workspaceId: string, opts: {
  id: string
  actualOutcome: string
  actualConfidence: number    // operator's hindsight 0..1
}): Promise<{ calibrationScore: number }> {
  const [d] = await db.select().from(decisions)
    .where(and(eq(decisions.workspaceId, workspaceId), eq(decisions.id, opts.id))).limit(1)
  if (!d) throw new Error('decision not found')
  // Calibration: how close was confidence to actual outcome score
  // outcomeScore = 1 if outcome matches expected, else 0..1 based on operator's actualConfidence
  const calibrationScore = 1 - Math.abs(d.confidence - Math.max(0, Math.min(opts.actualConfidence, 1)))
  await db.update(decisions).set({
    actualOutcome: opts.actualOutcome.slice(0, 4000),
    calibrationScore,
  }).where(eq(decisions.id, opts.id))
  return { calibrationScore }
}

export async function decisionList(workspaceId: string, opts: { dueOnly?: boolean; limit?: number } = {}): Promise<Array<typeof decisions.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 30, 200)
  if (opts.dueOnly) {
    return db.select().from(decisions)
      .where(and(eq(decisions.workspaceId, workspaceId), lte(decisions.reviewAt, Date.now()), sql`${decisions.actualOutcome} IS NULL`))
      .orderBy(decisions.reviewAt).limit(limit)
  }
  return db.select().from(decisions).where(eq(decisions.workspaceId, workspaceId))
    .orderBy(desc(decisions.decidedAt)).limit(limit)
}

// ─── #12 — Idea incubator ────────────────────────────────────────────

export async function ideaCapture(workspaceId: string, opts: {
  title: string
  body: string
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(ideasIncubator).values({
    id, workspaceId,
    title: opts.title.slice(0, 240),
    body: opts.body.slice(0, 8000),
    status: 'incubating',
    mentionCount: 0,
    createdAt: Date.now(),
  })
  return { id }
}

export async function ideaMention(workspaceId: string, ideaId: string): Promise<{ count: number }> {
  await db.update(ideasIncubator).set({
    mentionCount: sql`${ideasIncubator.mentionCount} + 1`,
    lastMentionedAt: Date.now(),
  }).where(and(eq(ideasIncubator.workspaceId, workspaceId), eq(ideasIncubator.id, ideaId)))
  const [row] = await db.select({ c: ideasIncubator.mentionCount }).from(ideasIncubator).where(eq(ideasIncubator.id, ideaId)).limit(1)
  return { count: row?.c ?? 0 }
}

export async function ideaSetStatus(workspaceId: string, opts: { id: string; status: 'incubating' | 'promoted' | 'discarded' }): Promise<{ ok: boolean }> {
  await db.update(ideasIncubator).set({ status: opts.status })
    .where(and(eq(ideasIncubator.workspaceId, workspaceId), eq(ideasIncubator.id, opts.id)))
  return { ok: true }
}

/**
 * Ideas still alive after N days that haven't been promoted/discarded —
 * candidates for action.
 */
export async function ideasResonating(workspaceId: string, opts: { minDaysOld?: number; minMentions?: number; limit?: number } = {}): Promise<Array<typeof ideasIncubator.$inferSelect>> {
  const minDays = opts.minDaysOld ?? 30
  const minMentions = opts.minMentions ?? 1
  const cutoff = Date.now() - minDays * DAY_MS
  return db.select().from(ideasIncubator)
    .where(and(
      eq(ideasIncubator.workspaceId, workspaceId),
      eq(ideasIncubator.status, 'incubating'),
      lte(ideasIncubator.createdAt, cutoff),
      gte(ideasIncubator.mentionCount, minMentions),
    ))
    .orderBy(desc(ideasIncubator.mentionCount), desc(ideasIncubator.lastMentionedAt))
    .limit(Math.min(opts.limit ?? 20, 100))
}

// ─── #13 — Q&A pairs ──────────────────────────────────────────────────

export async function qaCapture(workspaceId: string, opts: {
  question: string
  answer: string
  conversationId?: string
}): Promise<{ id: string; chunkId: string }> {
  const id = uuidv7()
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `Q: ${opts.question}\n\nA: ${opts.answer}`,
    sourceType: 'chat',
    metadata: { kind: 'qa_pair' },
  })
  await db.insert(qaPairs).values({
    id, workspaceId,
    question: opts.question.slice(0, 4000),
    answer: opts.answer.slice(0, 8000),
    conversationId: opts.conversationId ?? null,
    chunkId: stored.id,
    createdAt: Date.now(),
  })
  return { id, chunkId: stored.id }
}

export async function qaFind(workspaceId: string, opts: { query: string; k?: number }): Promise<Array<{ id: string; question: string; answer: string; similarity: number }>> {
  // Use semantic memory recall against qa-typed chunks
  const { memoryRecall } = await import('./r139-ai-foundation.js')
  const hits = await memoryRecall(workspaceId, { query: opts.query, k: Math.min(opts.k ?? 5, 20) })
  const out: Array<{ id: string; question: string; answer: string; similarity: number }> = []
  for (const h of hits) {
    const [qa] = await db.select().from(qaPairs)
      .where(and(eq(qaPairs.workspaceId, workspaceId), eq(qaPairs.chunkId, h.id))).limit(1)
    if (qa) {
      out.push({ id: qa.id, question: qa.question, answer: qa.answer, similarity: h.similarity })
      // Bump reuse count
      db.update(qaPairs).set({ reuseCount: sql`${qaPairs.reuseCount} + 1` }).where(eq(qaPairs.id, qa.id)).catch(() => null)
    }
  }
  return out
}

// ─── #14 — Concept maturity ──────────────────────────────────────────

/**
 * Tick: scan recent memory_tags + memory_chunks; bump reference counts
 * per concept; promote concepts based on thresholds.
 *
 * fresh (<3 refs), growing (3-9), mature (≥10), archived (no refs in 90d).
 */
export async function conceptMaturityTick(workspaceId: string): Promise<{ updated: number; mature: number; archived: number }> {
  const since = Date.now() - 30 * DAY_MS
  const tagCounts = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS n
    FROM memory_tags
    WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
    GROUP BY tag
  `) as unknown as Array<{ tag: string; n: number }>
  const now = Date.now()
  let updated = 0
  for (const { tag, n } of tagCounts) {
    const [existing] = await db.select().from(conceptMaturity)
      .where(and(eq(conceptMaturity.workspaceId, workspaceId), eq(conceptMaturity.concept, tag))).limit(1)
    const referenceCount = (existing?.referenceCount ?? 0) + (n - (existing?.referenceCount ?? 0))   // overwrite to current count
    const maturity = referenceCount >= 10 ? 'mature' : referenceCount >= 3 ? 'growing' : 'fresh'
    await db.insert(conceptMaturity).values({
      workspaceId, concept: tag,
      referenceCount, firstSeenAt: existing?.firstSeenAt ?? now, lastSeenAt: now, maturity,
    }).onConflictDoUpdate({
      target: [conceptMaturity.workspaceId, conceptMaturity.concept],
      set: { referenceCount, lastSeenAt: now, maturity },
    })
    updated++
  }
  // Archive concepts not seen in 90d
  const archiveCutoff = Date.now() - 90 * DAY_MS
  await db.update(conceptMaturity).set({ maturity: 'archived' })
    .where(and(eq(conceptMaturity.workspaceId, workspaceId), lte(conceptMaturity.lastSeenAt, archiveCutoff), sql`${conceptMaturity.maturity} != 'archived'`))
  const [maturedRow] = await db.select({ c: sql<number>`COUNT(*)::int` }).from(conceptMaturity).where(and(eq(conceptMaturity.workspaceId, workspaceId), eq(conceptMaturity.maturity, 'mature')))
  const [archivedRow] = await db.select({ c: sql<number>`COUNT(*)::int` }).from(conceptMaturity).where(and(eq(conceptMaturity.workspaceId, workspaceId), eq(conceptMaturity.maturity, 'archived')))
  return { updated, mature: maturedRow?.c ?? 0, archived: archivedRow?.c ?? 0 }
}

export async function conceptMaturityList(workspaceId: string, opts: { maturity?: string; limit?: number } = {}): Promise<Array<typeof conceptMaturity.$inferSelect>> {
  const where = opts.maturity
    ? and(eq(conceptMaturity.workspaceId, workspaceId), eq(conceptMaturity.maturity, opts.maturity))
    : eq(conceptMaturity.workspaceId, workspaceId)
  return db.select().from(conceptMaturity).where(where).orderBy(desc(conceptMaturity.referenceCount)).limit(Math.min(opts.limit ?? 50, 500))
}

// ─── #15 — Knowledge index with operators ────────────────────────────

/**
 * Search syntax: `tag:X since:2025-01-01 -decision`.
 *  - `tag:X`           → must have tag X
 *  - `since:YYYY-MM-DD`→ created on or after
 *  - `until:YYYY-MM-DD`→ created on or before
 *  - `kind:X`          → metadata.kind = X (e.g., daily_note, weekly_review)
 *  - `-X`              → exclude X from content
 *  - bare words        → must appear in content
 */
export async function knowledgeSearch(workspaceId: string, queryString: string, limit = 30): Promise<Array<{ chunkId: string; preview: string; matchedOps: string[] }>> {
  const tokens = queryString.split(/\s+/).filter(Boolean)
  const tagsRequired: string[] = []
  let sinceMs: number | null = null
  let untilMs: number | null = null
  let kindRequired: string | null = null
  const excludeContent: string[] = []
  const requireContent: string[] = []
  for (const tok of tokens) {
    if (tok.startsWith('tag:')) tagsRequired.push(tok.slice(4).toLowerCase())
    else if (tok.startsWith('since:')) {
      const d = new Date(`${tok.slice(6)}T00:00:00Z`).getTime()
      if (!isNaN(d)) sinceMs = d
    }
    else if (tok.startsWith('until:')) {
      const d = new Date(`${tok.slice(6)}T00:00:00Z`).getTime()
      if (!isNaN(d)) untilMs = d
    }
    else if (tok.startsWith('kind:')) kindRequired = tok.slice(5)
    else if (tok.startsWith('-')) excludeContent.push(tok.slice(1).toLowerCase())
    else requireContent.push(tok.toLowerCase())
  }
  // Build SQL
  const conds: ReturnType<typeof sql>[] = [sql`workspace_id = ${workspaceId}`]
  if (sinceMs !== null) conds.push(sql`created_at >= ${sinceMs}`)
  if (untilMs !== null) conds.push(sql`created_at <= ${untilMs + DAY_MS}`)
  if (kindRequired) conds.push(sql`(metadata->>'kind') = ${kindRequired}`)
  for (const word of requireContent) conds.push(sql`LOWER(content) LIKE ${`%${word}%`}`)
  for (const word of excludeContent) conds.push(sql`LOWER(content) NOT LIKE ${`%${word}%`}`)
  const where = conds.reduce((acc, c, i) => i === 0 ? c : sql`${acc} AND ${c}`)
  const rows = await db.execute(sql`
    SELECT id, LEFT(content, 200) AS preview
    FROM memory_chunks
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT ${Math.min(limit, 200)}
  `) as unknown as Array<{ id: string; preview: string }>
  // Filter by required tags
  const out: Array<{ chunkId: string; preview: string; matchedOps: string[] }> = []
  for (const r of rows) {
    if (tagsRequired.length > 0) {
      const tagRows = await db.select({ tag: memoryTags.tag }).from(memoryTags)
        .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.chunkId, r.id)))
      const tagSet = new Set(tagRows.map(t => t.tag))
      if (!tagsRequired.every(t => tagSet.has(t))) continue
    }
    out.push({ chunkId: r.id, preview: r.preview, matchedOps: tokens })
  }
  return out
}

// suppress unused; kept for future tagging hook
void dailyNotes
