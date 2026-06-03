/**
 * R146.155 — SB3 S-tier 1-5: proactive recall, question backlog,
 * predictive note assist, goal-to-daily decomposer, habit↔outcome correlation.
 */
import { db } from '../db/client.js'
import { questionsBacklog, memoryChunks, habits, habitLogs, moodLogs, keyResults, objectives } from '../db/schema.js'
import { and, eq, desc, gte, lte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000

// ─── #1 — Proactive recall ───────────────────────────────────────────

/**
 * Given current context (active chat / draft / topic), find memory chunks
 * that are semantically relevant but NOT recently accessed. Surface as
 * "you wrote about this before" suggestions.
 */
export async function proactiveRecall(workspaceId: string, opts: { context: string; k?: number; minAgeDays?: number }): Promise<Array<{ chunkId: string; preview: string; similarity: number; ageDays: number }>> {
  const minAge = (opts.minAgeDays ?? 30) * DAY_MS
  const { memoryRecall } = await import('./r139-ai-foundation.js')
  const hits = await memoryRecall(workspaceId, { query: opts.context.slice(0, 2000), k: Math.max(5, opts.k ?? 10) })
  const cutoff = Date.now() - minAge
  const out: Array<{ chunkId: string; preview: string; similarity: number; ageDays: number }> = []
  for (const h of hits) {
    const [chunk] = await db.select({ createdAt: memoryChunks.createdAt, lastAccessedAt: memoryChunks.lastAccessedAt }).from(memoryChunks).where(eq(memoryChunks.id, h.id)).limit(1)
    if (!chunk) continue
    const lastTouch = chunk.lastAccessedAt ?? chunk.createdAt
    if (lastTouch > cutoff) continue
    out.push({
      chunkId: h.id, preview: h.content.slice(0, 200),
      similarity: h.similarity,
      ageDays: Math.floor((Date.now() - lastTouch) / DAY_MS),
    })
    if (out.length >= (opts.k ?? 5)) break
  }
  return out
}

// ─── #2 — Question backlog ───────────────────────────────────────────

export async function questionRaise(workspaceId: string, opts: { question: string; contextChunkId?: string; priority?: 0 | 1 | 2 }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(questionsBacklog).values({
    id, workspaceId,
    question: opts.question.slice(0, 2000),
    contextChunkId: opts.contextChunkId ?? null,
    status: 'open',
    raisedAt: Date.now(),
    priority: opts.priority ?? 1,
  })
  return { id }
}

export async function questionAnswer(workspaceId: string, opts: { id: string; answerChunkId?: string }): Promise<{ ok: boolean }> {
  await db.update(questionsBacklog).set({
    status: 'answered', answeredAt: Date.now(),
    answerChunkId: opts.answerChunkId ?? null,
  }).where(and(eq(questionsBacklog.workspaceId, workspaceId), eq(questionsBacklog.id, opts.id)))
  return { ok: true }
}

export async function questionDrop(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.update(questionsBacklog).set({ status: 'dropped' })
    .where(and(eq(questionsBacklog.workspaceId, workspaceId), eq(questionsBacklog.id, id)))
  return { ok: true }
}

export async function questionBacklog(workspaceId: string, opts: { minPriority?: number; limit?: number } = {}): Promise<Array<typeof questionsBacklog.$inferSelect>> {
  const minPriority = opts.minPriority ?? 0
  return db.select().from(questionsBacklog)
    .where(and(eq(questionsBacklog.workspaceId, workspaceId), eq(questionsBacklog.status, 'open'), gte(questionsBacklog.priority, minPriority)))
    .orderBy(desc(questionsBacklog.priority), questionsBacklog.raisedAt)
    .limit(Math.min(opts.limit ?? 30, 200))
}

// ─── #3 — Predictive note assist ─────────────────────────────────────

/**
 * Continue a draft using the operator's recorded writing style.
 * Skeleton: pulls operator profile + recent notes as context, prompts
 * LLM to continue in same voice. Future round wires this through a
 * locally fine-tuned model.
 */
export async function noteContinue(workspaceId: string, opts: { draftStart: string; maxTokens?: number }): Promise<{ continuation: string }> {
  const { streamChat } = await import('./chat-providers.js')
  // Pull operator's recent notes for style sample
  const recentNotes = await db.select({ content: memoryChunks.content }).from(memoryChunks)
    .where(eq(memoryChunks.workspaceId, workspaceId))
    .orderBy(desc(memoryChunks.createdAt)).limit(5)
  const styleSample = recentNotes.map(n => n.content.slice(0, 400)).join('\n---\n').slice(0, 4000)
  const { profileToPromptPrefix } = await import('./r141-ai-b-tier.js')
  const profilePrefix = await profileToPromptPrefix(workspaceId)
  const sys = `Continue the operator's draft IN THEIR VOICE. Match tone, vocabulary, formatting (headings, bullets), sentence length. ${profilePrefix}\n\nRecent writing samples:\n${styleSample}\n\nContinue from where they stopped. 1-3 sentences max. Don't restart their text — only append.`
  const gen = streamChat(workspaceId, [
    { role: 'system', content: sys },
    { role: 'user',   content: `Draft so far:\n${opts.draftStart.slice(0, 4000)}\n\nContinue:` },
  ], { taskType: 'other', maxTokens: opts.maxTokens ?? 120 } as Parameters<typeof streamChat>[2])
  let continuation = ''
  for await (const ch of gen) continuation += ch.delta
  return { continuation: continuation.trim().slice(0, 1000) }
}

// ─── #4 — Goal-to-daily decomposer ───────────────────────────────────

/**
 * Given an objective, suggest concrete daily actions that move it forward.
 * Output: array of suggested tasks ready to drop into a daily note.
 */
export async function goalDecompose(workspaceId: string, opts: { objectiveId: string; horizonDays?: number; tasksPerDay?: number }): Promise<{ objective: string; tasks: Array<{ day: number; task: string; relatedKr?: string }> }> {
  const [obj] = await db.select().from(objectives)
    .where(and(eq(objectives.workspaceId, workspaceId), eq(objectives.id, opts.objectiveId))).limit(1)
  if (!obj) throw new Error('objective not found')
  const krs = await db.select().from(keyResults).where(eq(keyResults.objectiveId, opts.objectiveId))
  const horizon = Math.max(1, Math.min(opts.horizonDays ?? 14, 90))
  const tasksPerDay = Math.max(1, Math.min(opts.tasksPerDay ?? 3, 6))
  let tasks: Array<{ day: number; task: string; relatedKr?: string }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Decompose an objective + KRs into concrete daily actions over ${horizon} days, ${tasksPerDay} per day. Return STRICT JSON: {"tasks":[{"day":1..${horizon},"task":"<verb-led, <80 chars>","relatedKr":"<kr id or null>"}]}. Vary depth (some hard, some easy). Tasks must be doable in <2 hours.`
    const body = `Objective: ${obj.title}\nQuarter: ${obj.quarter}\nKey results:\n${krs.map(k => `- [${k.id}] ${k.title} (current: ${k.currentValue}/${k.targetValue ?? '?'} ${k.unit ?? ''}, conf: ${k.confidence})`).join('\n')}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: body },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { tasks?: Array<{ day: number; task: string; relatedKr?: string | null }> }
      tasks = (parsed.tasks ?? []).slice(0, horizon * tasksPerDay).map(t => ({
        day: Math.max(1, Math.min(t.day, horizon)),
        task: String(t.task).slice(0, 200),
        ...(t.relatedKr ? { relatedKr: String(t.relatedKr) } : {}),
      }))
    }
  } catch { /* empty */ }
  return { objective: obj.title, tasks }
}

// ─── #5 — Habit ↔ outcome correlation ────────────────────────────────

/**
 * Does habit X correlate with higher mood or energy on the NEXT day?
 * Pearson on daily binary habit-done vs next-day avg mood/energy.
 */
export async function habitOutcomeCorr(workspaceId: string, opts: { habitId: string; outcome?: 'mood' | 'energy'; windowDays?: number }): Promise<{ correlation: number; pairCount: number; insight: string }> {
  const windowDays = Math.max(14, Math.min(opts.windowDays ?? 60, 365))
  const since = Date.now() - windowDays * DAY_MS
  const sinceDate = new Date(since).toISOString().slice(0, 10)
  const logs = await db.select().from(habitLogs)
    .where(and(eq(habitLogs.workspaceId, workspaceId), eq(habitLogs.habitId, opts.habitId), gte(habitLogs.date, sinceDate)))
  const moods = await db.select().from(moodLogs)
    .where(and(eq(moodLogs.workspaceId, workspaceId), gte(moodLogs.date, sinceDate)))
  const outcome = opts.outcome ?? 'mood'
  // Build pairs: for each habit log day, next-day avg outcome
  const byNextDay = new Map<string, number[]>()
  for (const m of moods) {
    const cur = byNextDay.get(m.date) ?? []
    cur.push(outcome === 'mood' ? m.mood : m.energy)
    byNextDay.set(m.date, cur)
  }
  const pairs: Array<[number, number]> = []
  for (const log of logs) {
    const nextDate = new Date(`${log.date}T00:00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1)
    const nextStr = nextDate.toISOString().slice(0, 10)
    const nextVals = byNextDay.get(nextStr)
    if (!nextVals || nextVals.length === 0) continue
    const avg = nextVals.reduce((a, b) => a + b, 0) / nextVals.length
    pairs.push([log.done ? 1 : 0, avg])
  }
  if (pairs.length < 5) return { correlation: 0, pairCount: pairs.length, insight: 'need at least 5 paired days for a meaningful correlation' }
  // Pearson
  const n = pairs.length
  const xs = pairs.map(p => p[0])
  const ys = pairs.map(p => p[1])
  const meanX = xs.reduce((a, b) => a + b, 0) / n
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, denX = 0, denY = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX, dy = ys[i]! - meanY
    num += dx * dy; denX += dx * dx; denY += dy * dy
  }
  const correlation = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0
  const insight = Math.abs(correlation) < 0.15
    ? `no strong link (r=${correlation.toFixed(2)})`
    : correlation > 0
      ? `positive: doing this habit correlates with higher next-day ${outcome} (r=${correlation.toFixed(2)})`
      : `negative: doing this habit correlates with LOWER next-day ${outcome} (r=${correlation.toFixed(2)})`
  return { correlation, pairCount: n, insight }
}

// Suppress unused
void habits; void lte
