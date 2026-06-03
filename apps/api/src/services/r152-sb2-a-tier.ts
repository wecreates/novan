/**
 * R146.152 — SB2 A-tier: digest emails, annotations, revisions,
 * confidence scoring, cross-reference verification.
 */
import { db } from '../db/client.js'
import { digestSubscriptions, chunkAnnotations, chunkRevisions, chunkConfidence, memoryChunks } from '../db/schema.js'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

const DAY_MS = 24 * 60 * 60_000

// ─── #6 — Smart digest emails ────────────────────────────────────────

export async function digestSubscribe(workspaceId: string, opts: { email: string; cadence?: 'weekly' | 'monthly' }): Promise<{ ok: boolean }> {
  await db.insert(digestSubscriptions).values({
    workspaceId, email: opts.email.slice(0, 320),
    cadence: opts.cadence ?? 'weekly',
    active: true, updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: digestSubscriptions.workspaceId,
    set: { email: opts.email, cadence: opts.cadence ?? 'weekly', active: true, updatedAt: Date.now() },
  })
  return { ok: true }
}

/**
 * Build a digest payload (markdown body). Caller routes to email or
 * push. We don't ship email here — that's connector-level — but the
 * payload is ready to send.
 */
export async function digestBuild(workspaceId: string): Promise<{ subject: string; body: string; sentTo?: string }> {
  const since = Date.now() - 7 * DAY_MS
  const newChunkCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM memory_chunks WHERE workspace_id = ${workspaceId} AND created_at >= ${since}`) as unknown as Array<{ n: number }>
  const decisionsDue = await db.execute(sql`SELECT COUNT(*)::int AS n FROM decisions WHERE workspace_id = ${workspaceId} AND review_at <= ${Date.now()} AND actual_outcome IS NULL`) as unknown as Array<{ n: number }>
  const ideasResonating = await db.execute(sql`SELECT COUNT(*)::int AS n FROM ideas_incubator WHERE workspace_id = ${workspaceId} AND status = 'incubating' AND mention_count >= 1`) as unknown as Array<{ n: number }>
  const brokenHabits = await db.execute(sql`SELECT name FROM habits WHERE workspace_id = ${workspaceId} AND active = true AND (last_done_date IS NULL OR last_done_date < ${new Date(Date.now() - 2*DAY_MS).toISOString().slice(0,10)})`) as unknown as Array<{ name: string }>
  const lines: string[] = [
    `## This week in your brain`,
    `- **${newChunkCount[0]?.n ?? 0}** new chunks captured`,
    `- **${decisionsDue[0]?.n ?? 0}** decisions due for hindsight review`,
    `- **${ideasResonating[0]?.n ?? 0}** ideas still resonating`,
  ]
  if (brokenHabits.length > 0) lines.push(`- **Broken streaks:** ${brokenHabits.map(b => b.name).join(', ')}`)
  const body = lines.join('\n')
  const [sub] = await db.select().from(digestSubscriptions).where(eq(digestSubscriptions.workspaceId, workspaceId)).limit(1)
  if (sub) {
    await db.update(digestSubscriptions).set({ lastSentAt: Date.now() }).where(eq(digestSubscriptions.workspaceId, workspaceId))
  }
  const result: { subject: string; body: string; sentTo?: string } = { subject: `Novan digest · ${new Date().toISOString().slice(0, 10)}`, body }
  if (sub?.email) result.sentTo = sub.email
  return result
}

// ─── #7 — Chunk annotations ──────────────────────────────────────────

export async function annotationAdd(workspaceId: string, opts: {
  chunkId: string
  body: string
  color?: string
  startOffset?: number
  endOffset?: number
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(chunkAnnotations).values({
    id, workspaceId,
    chunkId: opts.chunkId,
    body: opts.body.slice(0, 4000),
    color: opts.color ?? 'yellow',
    startOffset: opts.startOffset ?? null,
    endOffset: opts.endOffset ?? null,
    createdAt: Date.now(),
  })
  return { id }
}

export async function annotationsForChunk(workspaceId: string, chunkId: string): Promise<Array<typeof chunkAnnotations.$inferSelect>> {
  return db.select().from(chunkAnnotations)
    .where(and(eq(chunkAnnotations.workspaceId, workspaceId), eq(chunkAnnotations.chunkId, chunkId)))
    .orderBy(chunkAnnotations.startOffset).limit(200)
}

export async function annotationDelete(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await db.delete(chunkAnnotations).where(and(eq(chunkAnnotations.workspaceId, workspaceId), eq(chunkAnnotations.id, id)))
  return { ok: true }
}

// ─── #8 — Revision history ───────────────────────────────────────────

/**
 * Edit a chunk: snapshots previous content into chunk_revisions, then
 * updates the chunk. Returns revision id for revert.
 */
export async function chunkEdit(workspaceId: string, opts: { chunkId: string; newContent: string }): Promise<{ revisionId: string }> {
  const [current] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId))).limit(1)
  if (!current) throw new Error('chunk not found')
  const revisionId = uuidv7()
  await db.insert(chunkRevisions).values({
    id: revisionId, workspaceId,
    chunkId: opts.chunkId,
    prevContent: current.content,
    diffSummary: `${current.content.length} → ${opts.newContent.length} chars`,
    editedAt: Date.now(),
  })
  await db.update(memoryChunks).set({ content: opts.newContent.slice(0, 10_000) })
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId)))
  return { revisionId }
}

export async function chunkRevisionsList(workspaceId: string, chunkId: string): Promise<Array<typeof chunkRevisions.$inferSelect>> {
  return db.select().from(chunkRevisions)
    .where(and(eq(chunkRevisions.workspaceId, workspaceId), eq(chunkRevisions.chunkId, chunkId)))
    .orderBy(desc(chunkRevisions.editedAt)).limit(50)
}

export async function chunkRevert(workspaceId: string, revisionId: string): Promise<{ ok: boolean }> {
  const [rev] = await db.select().from(chunkRevisions)
    .where(and(eq(chunkRevisions.workspaceId, workspaceId), eq(chunkRevisions.id, revisionId))).limit(1)
  if (!rev) return { ok: false }
  // Snapshot current first so revert is also revertable
  await chunkEdit(workspaceId, { chunkId: rev.chunkId, newContent: rev.prevContent })
  return { ok: true }
}

// ─── #9 — Confidence scoring ─────────────────────────────────────────

export async function confidenceSet(workspaceId: string, opts: {
  chunkId: string
  confidence: number
  sources?: string[]
}): Promise<{ ok: boolean }> {
  const conf = Math.max(0, Math.min(opts.confidence, 1))
  await db.insert(chunkConfidence).values({
    workspaceId, chunkId: opts.chunkId,
    confidence: conf,
    sources: opts.sources ?? [],
    contradictions: [],
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [chunkConfidence.workspaceId, chunkConfidence.chunkId],
    set: { confidence: conf, sources: opts.sources ?? [], updatedAt: Date.now() },
  })
  return { ok: true }
}

export async function confidenceLow(workspaceId: string, threshold = 0.4, limit = 20): Promise<Array<{ chunkId: string; confidence: number; preview: string }>> {
  const rows = await db.execute(sql`
    SELECT cc.chunk_id AS id, cc.confidence AS conf, LEFT(mc.content, 200) AS preview
    FROM chunk_confidence cc
    LEFT JOIN memory_chunks mc ON mc.id = cc.chunk_id
    WHERE cc.workspace_id = ${workspaceId} AND cc.confidence < ${threshold}
    ORDER BY cc.confidence ASC LIMIT ${limit}
  `) as unknown as Array<{ id: string; conf: number; preview: string }>
  return rows.map(r => ({ chunkId: r.id, confidence: r.conf, preview: r.preview ?? '' }))
}

// ─── #10 — Cross-reference verification ──────────────────────────────

/**
 * Given a chunk with claims, search the rest of memory for potential
 * contradictions via semantic similarity + LLM verdict. Persist any
 * found contradictions on the chunk_confidence row.
 */
export async function crossRefVerify(workspaceId: string, chunkId: string): Promise<{ contradictions: Array<{ chunkId: string; reason: string; preview: string }>; checked: number }> {
  const [chunk] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, chunkId))).limit(1)
  if (!chunk) return { contradictions: [], checked: 0 }
  // Semantic recall — top 10 similar chunks (excluding self)
  const { memoryRecall } = await import('./r139-ai-foundation.js')
  const candidates = (await memoryRecall(workspaceId, { query: chunk.content.slice(0, 1000), k: 10 })).filter(h => h.id !== chunkId)
  if (candidates.length === 0) return { contradictions: [], checked: 0 }
  const contradictions: Array<{ chunkId: string; reason: string; preview: string }> = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `You check claims for contradictions. Given a SOURCE claim + N candidate notes, identify which (if any) directly contradict the source. Return STRICT JSON: {"contradictions":[{"chunkId":"...","reason":"<one short sentence>"}]}. Empty array if none.`
    const candidatesText = candidates.map((c, i) => `[${i}] id=${c.id}\n${c.content.slice(0, 400)}`).join('\n\n')
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `SOURCE:\n${chunk.content.slice(0, 2000)}\n\nCANDIDATES:\n${candidatesText.slice(0, 6000)}` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { contradictions?: Array<{ chunkId: string; reason: string }> }
      for (const c of parsed.contradictions ?? []) {
        const found = candidates.find(cd => cd.id === c.chunkId)
        if (found) contradictions.push({ chunkId: c.chunkId, reason: c.reason.slice(0, 240), preview: found.content.slice(0, 200) })
      }
    }
  } catch { /* no verdict */ }
  // Persist
  if (contradictions.length > 0) {
    await db.insert(chunkConfidence).values({
      workspaceId, chunkId,
      confidence: 0.5,
      sources: [], contradictions: contradictions.map(c => ({ chunkId: c.chunkId, reason: c.reason })),
      updatedAt: Date.now(),
    }).onConflictDoUpdate({
      target: [chunkConfidence.workspaceId, chunkConfidence.chunkId],
      set: { contradictions: contradictions.map(c => ({ chunkId: c.chunkId, reason: c.reason })), updatedAt: Date.now() },
    })
  }
  return { contradictions, checked: candidates.length }
}

// suppress unused
void gte
