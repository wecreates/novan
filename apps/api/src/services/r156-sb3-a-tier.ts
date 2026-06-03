/**
 * R146.156 — SB3 A-tier: yearly review, identity timeline, calibration
 * trend over time, memory archaeology (belief shifts), resonance score.
 */
import { db } from '../db/client.js'
import { memoryChunks, memoryLinks, decisions, dailyNotes, weeklyReviews } from '../db/schema.js'
import { and, eq, desc, gte, lte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000

// ─── #6 — Yearly review ──────────────────────────────────────────────

export async function yearlyReviewGenerate(workspaceId: string, year: number): Promise<{ chunkId: string; synthesis: string }> {
  const yearStart = new Date(`${year}-01-01T00:00:00Z`).getTime()
  const yearEnd = new Date(`${year + 1}-01-01T00:00:00Z`).getTime()
  // Pull weekly reviews from the year
  const weeklies = await db.select({ s: weeklyReviews.synthesis, w: weeklyReviews.weekStarting })
    .from(weeklyReviews)
    .where(and(eq(weeklyReviews.workspaceId, workspaceId), gte(weeklyReviews.generatedAt, yearStart), lte(weeklyReviews.generatedAt, yearEnd)))
    .orderBy(weeklyReviews.weekStarting).limit(60)
  const [chunkCount] = await db.execute(sql`SELECT COUNT(*)::int AS n FROM memory_chunks WHERE workspace_id = ${workspaceId} AND created_at >= ${yearStart} AND created_at < ${yearEnd}`) as unknown as Array<{ n: number }>
  const [decisionCount] = await db.execute(sql`SELECT COUNT(*)::int AS n FROM decisions WHERE workspace_id = ${workspaceId} AND decided_at >= ${yearStart} AND decided_at < ${yearEnd}`) as unknown as Array<{ n: number }>
  let synthesis = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Synthesize a year. Sections: Year theme (1 para) · Top 3 wins · Top 3 misses · Identity shifts (what changed in how the operator sees themselves) · Top 5 carryover questions · 1 sentence prediction for next year. ~600 words.`
    const body = `Year: ${year}\nNew chunks: ${chunkCount?.n ?? 0}\nDecisions logged: ${decisionCount?.n ?? 0}\n\nWeekly review excerpts:\n${weeklies.map(w => `[${w.w}] ${(w.s ?? '').slice(0, 400)}`).join('\n\n').slice(0, 16000)}`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: body },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) synthesis += ch.delta
  } catch (e) {
    synthesis = `(year synthesis unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `# Yearly review: ${year}\n\n${synthesis}`,
    sourceType: 'doc',
    metadata: { kind: 'yearly_review', year },
  })
  return { chunkId: stored.id, synthesis }
}

// ─── #7 — Identity timeline ──────────────────────────────────────────

/**
 * Scan chunks for "I am X" / "I value X" / "my goal is X" patterns,
 * cluster + chart how stated identity has evolved.
 */
export async function identityTimeline(workspaceId: string, opts: { windowDays?: number } = {}): Promise<{ statements: Array<{ date: string; statement: string; chunkId: string }> }> {
  const since = Date.now() - (opts.windowDays ?? 365) * DAY_MS
  const rows = await db.execute(sql`
    SELECT id, LEFT(content, 1500) AS content, to_char(to_timestamp(created_at / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date
    FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND created_at >= ${since}
      AND content ~* '\\m(i am|i value|my goal is|my mission is|i believe|i want to be)\\M'
    ORDER BY created_at LIMIT 200
  `) as unknown as Array<{ id: string; content: string; date: string }>
  const statements: Array<{ date: string; statement: string; chunkId: string }> = []
  const re = /\b(I am|I value|My goal is|My mission is|I believe|I want to be)\s+([^.!?\n]{1,180})/gi
  for (const r of rows) {
    for (const m of r.content.matchAll(re)) {
      statements.push({ date: r.date, statement: `${m[1]} ${m[2]?.trim()}`.slice(0, 200), chunkId: r.id })
      if (statements.length >= 100) break
    }
    if (statements.length >= 100) break
  }
  return { statements }
}

// ─── #8 — Calibration over time ──────────────────────────────────────

export async function calibrationTrend(workspaceId: string, opts: { windowMonths?: number } = {}): Promise<{ monthly: Array<{ month: string; avgScore: number; decisions: number }>; overall: number }> {
  const months = Math.max(3, Math.min(opts.windowMonths ?? 12, 36))
  const since = Date.now() - months * 30 * DAY_MS
  const rows = await db.execute(sql`
    SELECT to_char(date_trunc('month', to_timestamp(decided_at / 1000) AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
           AVG(calibration_score)::real AS avg_score,
           COUNT(*)::int AS n
    FROM decisions
    WHERE workspace_id = ${workspaceId} AND decided_at >= ${since} AND calibration_score IS NOT NULL
    GROUP BY month ORDER BY month
  `) as unknown as Array<{ month: string; avg_score: number; n: number }>
  const overall = rows.length > 0 ? rows.reduce((s, r) => s + r.avg_score * r.n, 0) / rows.reduce((s, r) => s + r.n, 0) : 0
  return {
    monthly: rows.map(r => ({ month: r.month, avgScore: r.avg_score, decisions: r.n })),
    overall,
  }
}

// ─── #9 — Memory archaeology (belief shifts) ─────────────────────────

/**
 * Find moments where the operator changed their mind about a topic.
 * Heuristic: chunks containing reversal language ("I used to think X but
 * now Y", "I was wrong about", "changed my mind on").
 */
export async function beliefShifts(workspaceId: string, limit = 30): Promise<Array<{ chunkId: string; date: string; excerpt: string }>> {
  const rows = await db.execute(sql`
    SELECT id, to_char(to_timestamp(created_at / 1000) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date, LEFT(content, 600) AS preview
    FROM memory_chunks
    WHERE workspace_id = ${workspaceId}
      AND content ~* '\\m(used to think|was wrong about|changed my mind|reconsidered|I no longer believe|I now think|update[ds]? my view)\\M'
    ORDER BY created_at DESC LIMIT ${limit}
  `) as unknown as Array<{ id: string; date: string; preview: string }>
  return rows.map(r => ({ chunkId: r.id, date: r.date, excerpt: r.preview }))
}

// ─── #10 — Resonance score ───────────────────────────────────────────

/**
 * For each chunk, count how many LATER chunks reference its ideas (via
 * incoming wiki/cite links OR semantic similarity to chunks that came
 * after). High resonance = the idea kept resonating with later thinking.
 */
export async function resonanceTop(workspaceId: string, limit = 20): Promise<Array<{ chunkId: string; resonance: number; preview: string; createdAt: number }>> {
  // Use existing backlink count + age weighting
  const rows = await db.execute(sql`
    SELECT mc.id AS id, mc.created_at AS created_at, LEFT(mc.content, 200) AS preview,
           (SELECT COUNT(*) FROM memory_links ml WHERE ml.dst_chunk_id = mc.id AND ml.created_at > mc.created_at) AS later_links
    FROM memory_chunks mc
    WHERE mc.workspace_id = ${workspaceId}
    ORDER BY later_links DESC LIMIT ${limit}
  `) as unknown as Array<{ id: string; created_at: number; preview: string; later_links: number }>
  const now = Date.now()
  return rows.map(r => {
    const ageDays = Math.max(1, (now - r.created_at) / DAY_MS)
    // Resonance = links * sqrt(age) to reward old ideas that keep getting referenced
    const resonance = r.later_links * Math.sqrt(ageDays / 30)
    return { chunkId: r.id, resonance, preview: r.preview ?? '', createdAt: r.created_at }
  })
}

// suppress unused
void uuidv7; void memoryLinks; void dailyNotes
