/**
 * R146.148 — Second-brain A-tier: spaced repetition, personal CRM,
 * reading queue, backlinks-helper, cross-time weekly synthesis.
 */
import { db } from '../db/client.js'
import { srsCards, people, personInteractions, readingQueue, weeklyReviews, memoryChunks, dailyNotes } from '../db/schema.js'
import { and, eq, desc, gte, lte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000

// ─── #6 — Spaced repetition (SM-2 lite) ──────────────────────────────

export async function srsAdd(workspaceId: string, opts: {
  chunkId: string
  front: string
  back: string
}): Promise<{ id: string; nextReviewAt: number }> {
  const id = uuidv7()
  const now = Date.now()
  const nextReviewAt = now + DAY_MS
  await db.insert(srsCards).values({
    id, workspaceId, chunkId: opts.chunkId,
    front: opts.front.slice(0, 500), back: opts.back.slice(0, 2000),
    intervalDays: 1, ease: 2.5, reps: 0,
    nextReviewAt, createdAt: now,
  })
  return { id, nextReviewAt }
}

export async function srsDue(workspaceId: string, limit = 20): Promise<Array<typeof srsCards.$inferSelect>> {
  return db.select().from(srsCards)
    .where(and(eq(srsCards.workspaceId, workspaceId), lte(srsCards.nextReviewAt, Date.now())))
    .orderBy(srsCards.nextReviewAt).limit(Math.min(limit, 100))
}

/**
 * Grade 0-5 (Anki-style). Updates interval + ease via SM-2.
 */
export async function srsReview(workspaceId: string, opts: { id: string; grade: number }): Promise<{ nextReviewAt: number; intervalDays: number }> {
  const [card] = await db.select().from(srsCards)
    .where(and(eq(srsCards.workspaceId, workspaceId), eq(srsCards.id, opts.id))).limit(1)
  if (!card) throw new Error('card not found')
  const grade = Math.max(0, Math.min(opts.grade, 5))
  let { intervalDays, ease, reps } = card
  if (grade < 3) {
    reps = 0
    intervalDays = 1
  } else {
    reps++
    intervalDays = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(intervalDays * ease)
    ease = Math.max(1.3, ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02)))
  }
  const nextReviewAt = Date.now() + intervalDays * DAY_MS
  await db.update(srsCards).set({ intervalDays, ease, reps, nextReviewAt })
    .where(eq(srsCards.id, opts.id))
  return { nextReviewAt, intervalDays }
}

// ─── #7 — Personal CRM ───────────────────────────────────────────────

export async function personAdd(workspaceId: string, opts: {
  name: string
  email?: string
  org?: string
  notes?: string
}): Promise<{ id: string }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(people).values({
    id, workspaceId,
    name: opts.name.slice(0, 240),
    email: opts.email ?? null,
    org: opts.org ?? null,
    notes: opts.notes ?? null,
    createdAt: now, updatedAt: now,
  })
  return { id }
}

export async function personInteractionAdd(workspaceId: string, opts: {
  personId: string
  channel: 'meeting' | 'email' | 'dm' | 'call' | 'in_person'
  notes: string
  occurredAt?: number
  followUpInDays?: number
}): Promise<{ id: string }> {
  const id = uuidv7()
  const occurredAt = opts.occurredAt ?? Date.now()
  await db.insert(personInteractions).values({
    id, workspaceId,
    personId: opts.personId, channel: opts.channel,
    notes: opts.notes.slice(0, 4000), occurredAt,
    createdAt: Date.now(),
  })
  await db.update(people).set({
    lastContactAt: occurredAt,
    followUpAt: opts.followUpInDays ? Date.now() + opts.followUpInDays * DAY_MS : null,
    updatedAt: Date.now(),
  }).where(and(eq(people.workspaceId, workspaceId), eq(people.id, opts.personId)))
  return { id }
}

export async function personList(workspaceId: string, opts: { followUpDue?: boolean; limit?: number } = {}): Promise<Array<typeof people.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 50, 500)
  if (opts.followUpDue) {
    const now = Date.now()
    return db.select().from(people)
      .where(and(eq(people.workspaceId, workspaceId), lte(people.followUpAt, now), sql`${people.followUpAt} IS NOT NULL`))
      .orderBy(people.followUpAt).limit(limit)
  }
  return db.select().from(people)
    .where(eq(people.workspaceId, workspaceId))
    .orderBy(desc(people.lastContactAt))
    .limit(limit)
}

export async function personHistory(workspaceId: string, personId: string, limit = 50): Promise<Array<typeof personInteractions.$inferSelect>> {
  return db.select().from(personInteractions)
    .where(and(eq(personInteractions.workspaceId, workspaceId), eq(personInteractions.personId, personId)))
    .orderBy(desc(personInteractions.occurredAt))
    .limit(Math.min(limit, 200))
}

// ─── #8 — Reading queue ──────────────────────────────────────────────

export async function readingAdd(workspaceId: string, opts: {
  title: string
  url?: string
  estimatedMin?: number
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(readingQueue).values({
    id, workspaceId,
    title: opts.title.slice(0, 500),
    url: opts.url ?? null,
    estimatedMin: opts.estimatedMin ?? null,
    status: 'queued',
    addedAt: Date.now(),
  })
  return { id }
}

export async function readingStart(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.update(readingQueue).set({ status: 'reading', startedAt: Date.now() })
    .where(and(eq(readingQueue.workspaceId, workspaceId), eq(readingQueue.id, id)))
  return { ok: true }
}

export async function readingFinish(workspaceId: string, opts: { id: string; notesChunkId?: string }): Promise<{ ok: boolean }> {
  await db.update(readingQueue).set({
    status: 'done', finishedAt: Date.now(),
    notesChunkId: opts.notesChunkId ?? null,
  }).where(and(eq(readingQueue.workspaceId, workspaceId), eq(readingQueue.id, opts.id)))
  return { ok: true }
}

export async function readingList(workspaceId: string, opts: { status?: string; limit?: number } = {}): Promise<Array<typeof readingQueue.$inferSelect>> {
  const where = opts.status
    ? and(eq(readingQueue.workspaceId, workspaceId), eq(readingQueue.status, opts.status))
    : eq(readingQueue.workspaceId, workspaceId)
  return db.select().from(readingQueue).where(where).orderBy(desc(readingQueue.addedAt)).limit(Math.min(opts.limit ?? 30, 200))
}

// ─── #9 — Backlinks helper (graph stats) ─────────────────────────────

export async function backlinksTop(workspaceId: string, limit = 20): Promise<Array<{ chunkId: string; backlinkCount: number; preview: string }>> {
  const rows = await db.execute(sql`
    SELECT ml.dst_chunk_id AS chunk_id, COUNT(*)::int AS n,
           (SELECT LEFT(content, 200) FROM memory_chunks WHERE id = ml.dst_chunk_id) AS preview
    FROM memory_links ml
    WHERE ml.workspace_id = ${workspaceId}
    GROUP BY ml.dst_chunk_id
    ORDER BY n DESC LIMIT ${limit}
  `) as unknown as Array<{ chunk_id: string; n: number; preview: string }>
  return rows.map(r => ({ chunkId: r.chunk_id, backlinkCount: r.n, preview: r.preview ?? '' }))
}

export async function orphanChunks(workspaceId: string, limit = 30): Promise<Array<{ chunkId: string; preview: string }>> {
  const rows = await db.execute(sql`
    SELECT mc.id AS chunk_id, LEFT(mc.content, 200) AS preview
    FROM memory_chunks mc
    LEFT JOIN memory_links ml_out ON ml_out.src_chunk_id = mc.id
    LEFT JOIN memory_links ml_in  ON ml_in.dst_chunk_id  = mc.id
    WHERE mc.workspace_id = ${workspaceId}
      AND ml_out.id IS NULL AND ml_in.id IS NULL
    ORDER BY mc.created_at DESC LIMIT ${limit}
  `) as unknown as Array<{ chunk_id: string; preview: string }>
  return rows.map(r => ({ chunkId: r.chunk_id, preview: r.preview ?? '' }))
}

// ─── #10 — Cross-time synthesis (weekly review) ──────────────────────

function mondayOfWeek(t = Date.now()): string {
  const d = new Date(t)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (day - 1))
  return d.toISOString().slice(0, 10)
}

export async function weeklyReviewGenerate(workspaceId: string, week?: string): Promise<{ id: string; weekStarting: string; synthesis: string; chunkId: string | null }> {
  const weekStarting = week ?? mondayOfWeek()
  const weekStartMs = new Date(`${weekStarting}T00:00:00Z`).getTime()
  const weekEndMs = weekStartMs + 7 * DAY_MS
  // Gather what happened: new memory chunks + daily notes
  const newChunks = await db.select({ content: memoryChunks.content }).from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), gte(memoryChunks.createdAt, weekStartMs), lte(memoryChunks.createdAt, weekEndMs)))
    .limit(100)
  const dailies = await db.select().from(dailyNotes)
    .where(and(eq(dailyNotes.workspaceId, workspaceId), gte(dailyNotes.date, weekStarting), lte(dailyNotes.date, mondayOfWeek(weekStartMs + 6 * DAY_MS))))
    .orderBy(dailyNotes.date).limit(7)
  // LLM synthesis
  let synthesis = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Synthesize a week. Output: 1-paragraph theme of the week + 3-5 bullet points of insights/learnings + 1 question to carry forward. ~300 words.`
    const body = `Week of ${weekStarting}\n\nNew memory chunks (${newChunks.length}):\n${newChunks.map(c => c.content.slice(0, 300)).join('\n---\n').slice(0, 8000)}\n\nDaily notes: ${dailies.length}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user', content: body },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) synthesis += ch.delta
  } catch (e) {
    synthesis = `(synthesis unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  // Persist as memory chunk + weekly_reviews row
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `# Weekly review: ${weekStarting}\n\n${synthesis}`,
    sourceType: 'doc',
    metadata: { kind: 'weekly_review', week: weekStarting },
  })
  const id = uuidv7()
  await db.insert(weeklyReviews).values({
    id, workspaceId,
    weekStarting, synthesis: synthesis.slice(0, 8000),
    chunkId: stored.id,
    metrics: { newChunks: newChunks.length, dailies: dailies.length },
    generatedAt: Date.now(),
  }).onConflictDoNothing().catch(() => null)
  return { id, weekStarting, synthesis, chunkId: stored.id }
}

export async function weeklyReviewList(workspaceId: string, limit = 12): Promise<Array<typeof weeklyReviews.$inferSelect>> {
  return db.select().from(weeklyReviews).where(eq(weeklyReviews.workspaceId, workspaceId))
    .orderBy(desc(weeklyReviews.weekStarting)).limit(Math.min(limit, 52))
}
