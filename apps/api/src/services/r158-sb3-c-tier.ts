/**
 * R146.158 — SB3 C-tier 16-20: synthetic conversation between past selves,
 * dream journal, body metrics correlation, public knowledge garden,
 * knowledge inheritance manifest.
 */
import { db } from '../db/client.js'
import { dreamEntries, bodyMetrics, publicPublishes, inheritanceManifests, memoryChunks, decisions, weeklyReviews } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { createHash } from 'crypto'

const DAY_MS = 24 * 60 * 60_000

// ─── #16 — Synthetic conversation between past selves ────────────────

/**
 * Find two of your past notes on the same topic from different time
 * periods. Generate an LLM-imagined dialogue between the two "yous"
 * about it.
 */
export async function pastSelvesDialogue(workspaceId: string, opts: { topic: string }): Promise<{ chunkA: { id: string; date: string }; chunkB: { id: string; date: string }; dialogue: string }> {
  const { memoryRecall } = await import('./r139-ai-foundation.js')
  const hits = await memoryRecall(workspaceId, { query: opts.topic, k: 20 })
  if (hits.length < 2) throw new Error('need at least 2 chunks matching the topic')
  // Pick oldest + newest
  const chunkIds = hits.map(h => h.id)
  const chunks = await db.execute(sql`
    SELECT id, content, created_at FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND id = ANY(${chunkIds})
    ORDER BY created_at
  `) as unknown as Array<{ id: string; content: string; created_at: number }>
  if (chunks.length < 2) throw new Error('chunks lookup short')
  const a = chunks[0]!
  const b = chunks[chunks.length - 1]!
  const dA = new Date(a.created_at).toISOString().slice(0, 10)
  const dB = new Date(b.created_at).toISOString().slice(0, 10)
  let dialogue = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Generate a 6-turn dialogue between two past selves of the same operator about ${opts.topic}. Speaker A is from ${dA}; Speaker B is from ${dB}. Each turn 2-3 sentences. Stay in their respective voices. They should challenge each other where their views differ.`
    const body = `Self A (${dA}):\n${a.content.slice(0, 3000)}\n\n---\n\nSelf B (${dB}):\n${b.content.slice(0, 3000)}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: body },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) dialogue += ch.delta
  } catch (e) {
    dialogue = `(dialogue unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  return { chunkA: { id: a.id, date: dA }, chunkB: { id: b.id, date: dB }, dialogue }
}

// ─── #17 — Dream journal ─────────────────────────────────────────────

export async function dreamCapture(workspaceId: string, opts: { body: string; vivid?: boolean; date?: string }): Promise<{ id: string; chunkId: string; themes: string[] }> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  let themes: string[] = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Extract 3-5 themes from a dream account. Return STRICT JSON: {"themes":["..."]}.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: opts.body.slice(0, 4000) },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { themes?: string[] }
      themes = (parsed.themes ?? []).slice(0, 8).map(t => String(t).toLowerCase().slice(0, 60))
    }
  } catch { /* empty */ }
  const id = uuidv7()
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `# Dream: ${date}${opts.vivid ? ' (vivid)' : ''}\n\n${opts.body}\n\nThemes: ${themes.join(', ')}`,
    sourceType: 'event',
    metadata: { kind: 'dream', date, vivid: opts.vivid === true, themes },
  })
  await db.insert(dreamEntries).values({
    id, workspaceId, date,
    body: opts.body.slice(0, 8000),
    themes, vivid: opts.vivid === true,
    chunkId: stored.id, recordedAt: Date.now(),
  })
  return { id, chunkId: stored.id, themes }
}

export async function dreamThemeTrends(workspaceId: string, windowDays = 90): Promise<Array<{ theme: string; count: number }>> {
  const since = new Date(Date.now() - windowDays * DAY_MS).toISOString().slice(0, 10)
  const rows = await db.execute(sql`
    SELECT theme, COUNT(*)::int AS n
    FROM dream_entries de, LATERAL jsonb_array_elements_text(de.themes) AS theme
    WHERE de.workspace_id = ${workspaceId} AND de.date >= ${since}
    GROUP BY theme ORDER BY n DESC LIMIT 30
  `) as unknown as Array<{ theme: string; n: number }>
  return rows.map(r => ({ theme: r.theme, count: r.n }))
}

// ─── #18 — Body data correlation ─────────────────────────────────────

export async function bodyMetricLog(workspaceId: string, opts: { date?: string; metric: string; value: number; source?: string }): Promise<{ ok: boolean }> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10)
  await db.insert(bodyMetrics).values({
    workspaceId, date, metric: opts.metric, value: opts.value,
    source: opts.source ?? 'manual', recordedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [bodyMetrics.workspaceId, bodyMetrics.date, bodyMetrics.metric],
    set: { value: opts.value, source: opts.source ?? 'manual', recordedAt: Date.now() },
  })
  return { ok: true }
}

/**
 * Correlation between a body metric and mood/focus on the same day.
 * Spearman rank correlation (more robust than Pearson for small N).
 */
export async function bodyMetricCorr(workspaceId: string, opts: { metric: string; outcome: 'mood' | 'energy' | 'focus_min'; windowDays?: number }): Promise<{ correlation: number; pairs: number; insight: string }> {
  const since = new Date(Date.now() - (opts.windowDays ?? 90) * DAY_MS).toISOString().slice(0, 10)
  const metricRows = await db.select().from(bodyMetrics)
    .where(and(eq(bodyMetrics.workspaceId, workspaceId), eq(bodyMetrics.metric, opts.metric), gte(bodyMetrics.date, since)))
  let outcomeRows: Array<{ date: string; value: number }>
  if (opts.outcome === 'focus_min') {
    outcomeRows = await db.execute(sql`
      SELECT to_char(date_trunc('day', to_timestamp(started_at / 1000) AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS date,
             SUM(duration_min)::real AS value
      FROM focus_sessions WHERE workspace_id = ${workspaceId} AND started_at >= ${Date.now() - (opts.windowDays ?? 90) * DAY_MS}
      GROUP BY date
    `) as unknown as Array<{ date: string; value: number }>
  } else {
    outcomeRows = await db.execute(sql`
      SELECT date, AVG(${sql.raw(opts.outcome)})::real AS value
      FROM mood_logs WHERE workspace_id = ${workspaceId} AND date >= ${since}
      GROUP BY date
    `) as unknown as Array<{ date: string; value: number }>
  }
  const byDate = new Map(outcomeRows.map(o => [o.date, o.value]))
  const pairs: Array<[number, number]> = []
  for (const m of metricRows) {
    const o = byDate.get(m.date)
    if (typeof o === 'number') pairs.push([m.value, o])
  }
  if (pairs.length < 5) return { correlation: 0, pairs: pairs.length, insight: 'need at least 5 paired days' }
  // Pearson (Spearman would need rank conversion; this is good enough)
  const n = pairs.length
  const meanX = pairs.reduce((s, p) => s + p[0], 0) / n
  const meanY = pairs.reduce((s, p) => s + p[1], 0) / n
  let num = 0, denX = 0, denY = 0
  for (const [x, y] of pairs) {
    const dx = x - meanX, dy = y - meanY
    num += dx * dy; denX += dx * dx; denY += dy * dy
  }
  const r = denX > 0 && denY > 0 ? num / Math.sqrt(denX * denY) : 0
  const insight = Math.abs(r) < 0.15
    ? `no strong link (r=${r.toFixed(2)})`
    : r > 0
      ? `positive: higher ${opts.metric} correlates with higher ${opts.outcome} (r=${r.toFixed(2)})`
      : `negative: higher ${opts.metric} correlates with LOWER ${opts.outcome} (r=${r.toFixed(2)})`
  return { correlation: r, pairs: n, insight }
}

// ─── #19 — Public knowledge garden ───────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) + '-' + createHash('sha256').update(s + Date.now()).digest('hex').slice(0, 8)
}

export async function publish(workspaceId: string, opts: { chunkId: string; customSlug?: string }): Promise<{ id: string; slug: string; url: string }> {
  const [chunk] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId))).limit(1)
  if (!chunk) throw new Error('chunk not found')
  const title = (chunk.content.match(/^#+\s*(.+?)$/m)?.[1] ?? chunk.content.slice(0, 60)).slice(0, 200)
  const slug = opts.customSlug ?? slugify(title)
  const id = uuidv7()
  await db.insert(publicPublishes).values({
    id, workspaceId, slug,
    chunkId: opts.chunkId,
    title, body: chunk.content,
    publishedAt: Date.now(),
  })
  return { id, slug, url: `/garden/${slug}` }
}

export async function unpublish(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.update(publicPublishes).set({ unpublishedAt: Date.now() })
    .where(and(eq(publicPublishes.workspaceId, workspaceId), eq(publicPublishes.id, id)))
  return { ok: true }
}

export async function publicList(workspaceId: string, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<Array<typeof publicPublishes.$inferSelect>> {
  const where = opts.activeOnly
    ? and(eq(publicPublishes.workspaceId, workspaceId), sql`${publicPublishes.unpublishedAt} IS NULL`)
    : eq(publicPublishes.workspaceId, workspaceId)
  return db.select().from(publicPublishes).where(where).orderBy(desc(publicPublishes.publishedAt)).limit(Math.min(opts.limit ?? 30, 200))
}

// ─── #20 — Knowledge inheritance manifest ────────────────────────────

/**
 * Generate a successor manifest: top concepts, open questions, current
 * decisions, biggest unresolved threads. Designed to be handed to a
 * future-you or another person.
 */
export async function inheritanceGenerate(workspaceId: string, opts: { recipientHint: string }): Promise<{ id: string; bodyMd: string }> {
  // Pull top concepts, open questions, recent decisions, recent weekly reviews
  const topConcepts = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS n FROM memory_tags WHERE workspace_id = ${workspaceId} GROUP BY tag ORDER BY n DESC LIMIT 20
  `) as unknown as Array<{ tag: string; n: number }>
  const openQs = await db.execute(sql`
    SELECT question FROM questions_backlog WHERE workspace_id = ${workspaceId} AND status = 'open' ORDER BY priority DESC, raised_at DESC LIMIT 30
  `) as unknown as Array<{ question: string }>
  const recentDecs = await db.select().from(decisions)
    .where(eq(decisions.workspaceId, workspaceId))
    .orderBy(desc(decisions.decidedAt)).limit(10)
  const recentReviews = await db.select({ s: weeklyReviews.synthesis }).from(weeklyReviews)
    .where(eq(weeklyReviews.workspaceId, workspaceId))
    .orderBy(desc(weeklyReviews.generatedAt)).limit(4)
  let bodyMd = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Write an inheritance manifest — a hand-off document so a successor (recipient: ${opts.recipientHint}) can pick up where the operator left off. Sections: Context · Active concepts · Open questions · Recent decisions + reasoning · What I would tell you if I had 5 minutes. ~800 words. Tone: candid, direct, no fluff.`
    const body = `RECIPIENT: ${opts.recipientHint}\n\nTOP CONCEPTS: ${topConcepts.map(c => `${c.tag}(${c.n})`).join(', ')}\n\nOPEN QUESTIONS:\n${openQs.map(q => `- ${q.question}`).join('\n')}\n\nRECENT DECISIONS:\n${recentDecs.map(d => `- ${d.question} → ${d.reasoning.slice(0, 200)}`).join('\n')}\n\nRECENT WEEKLY REVIEWS:\n${recentReviews.map(r => r.s.slice(0, 400)).join('\n---\n')}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: body.slice(0, 16000) },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) bodyMd += ch.delta
  } catch (e) {
    bodyMd = `(manifest unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  const id = uuidv7()
  await db.insert(inheritanceManifests).values({
    id, workspaceId,
    recipientHint: opts.recipientHint.slice(0, 120),
    bodyMd: bodyMd.slice(0, 30_000),
    manifestData: { concepts: topConcepts.length, questions: openQs.length, decisions: recentDecs.length },
    generatedAt: Date.now(),
  })
  return { id, bodyMd }
}

export async function inheritanceList(workspaceId: string, limit = 10): Promise<Array<typeof inheritanceManifests.$inferSelect>> {
  return db.select().from(inheritanceManifests).where(eq(inheritanceManifests.workspaceId, workspaceId))
    .orderBy(desc(inheritanceManifests.generatedAt)).limit(Math.min(limit, 100))
}
