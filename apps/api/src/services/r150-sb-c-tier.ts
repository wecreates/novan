/**
 * R146.150 — SB C-tier 16-20: mind-map data + memory time-travel +
 * reflective dialogue agent + voice journal + external knowledge import.
 */
import { db } from '../db/client.js'
import { memorySnapshots, voiceJournals, externalImports, memoryChunks, memoryLinks, memoryTags } from '../db/schema.js'
import { and, eq, desc, lte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #16 — Mind-map data ─────────────────────────────────────────────

/**
 * Build the data for an interactive 2D mind-map. Returns nodes
 * (chunkId, preview, tags, degree) + edges (src, dst, type).
 *
 * Honest scope: data structure only. UI rendering is a future round.
 */
export async function mindMapBuild(workspaceId: string, opts: { tag?: string; limit?: number } = {}): Promise<{
  nodes: Array<{ id: string; preview: string; degree: number; tags: string[] }>
  edges: Array<{ src: string; dst: string; type: string }>
}> {
  const limit = Math.min(opts.limit ?? 100, 500)
  // If tag filter, find chunks with that tag
  let chunkIds: string[] = []
  if (opts.tag) {
    const tagRows = await db.select({ chunkId: memoryTags.chunkId }).from(memoryTags)
      .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.tag, opts.tag.toLowerCase())))
      .limit(limit)
    chunkIds = tagRows.map(r => r.chunkId)
  } else {
    // Most-linked chunks
    const top = await db.execute(sql`
      SELECT dst_chunk_id AS id, COUNT(*)::int AS n FROM memory_links
      WHERE workspace_id = ${workspaceId}
      GROUP BY dst_chunk_id ORDER BY n DESC LIMIT ${limit}
    `) as unknown as Array<{ id: string; n: number }>
    chunkIds = top.map(r => r.id)
  }
  if (chunkIds.length === 0) return { nodes: [], edges: [] }
  // Fetch chunk previews
  const chunkRows = await db.execute(sql`
    SELECT id, LEFT(content, 200) AS preview FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND id = ANY(${chunkIds})
  `) as unknown as Array<{ id: string; preview: string }>
  // Tags per chunk
  const tagRows = await db.select().from(memoryTags)
    .where(and(eq(memoryTags.workspaceId, workspaceId), sql`${memoryTags.chunkId} = ANY(${chunkIds})`))
  const tagsByChunk = new Map<string, string[]>()
  for (const t of tagRows) {
    const cur = tagsByChunk.get(t.chunkId) ?? []
    cur.push(t.tag); tagsByChunk.set(t.chunkId, cur)
  }
  // Edges between these chunks
  const edges = await db.select().from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, workspaceId), sql`${memoryLinks.srcChunkId} = ANY(${chunkIds})`, sql`${memoryLinks.dstChunkId} = ANY(${chunkIds})`))
    .limit(1000)
  // Degree count
  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.srcChunkId, (degree.get(e.srcChunkId) ?? 0) + 1)
    degree.set(e.dstChunkId, (degree.get(e.dstChunkId) ?? 0) + 1)
  }
  const nodes = chunkRows.map(r => ({
    id: r.id, preview: r.preview ?? '',
    degree: degree.get(r.id) ?? 0,
    tags: tagsByChunk.get(r.id) ?? [],
  }))
  return { nodes, edges: edges.map(e => ({ src: e.srcChunkId, dst: e.dstChunkId, type: e.linkType })) }
}

// ─── #17 — Memory time-travel (snapshots) ────────────────────────────

function utcDate(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10)
}

export async function snapshotCapture(workspaceId: string): Promise<{ id: string; chunkCount: number; linkCount: number; tagCount: number }> {
  const [chunkCount] = await db.select({ c: sql<number>`COUNT(*)::int` }).from(memoryChunks).where(eq(memoryChunks.workspaceId, workspaceId))
  const [linkCount]  = await db.select({ c: sql<number>`COUNT(*)::int` }).from(memoryLinks).where(eq(memoryLinks.workspaceId, workspaceId))
  const [tagCount]   = await db.select({ c: sql<number>`COUNT(*)::int` }).from(memoryTags).where(eq(memoryTags.workspaceId, workspaceId))
  // Manifest: top 50 most-linked chunks today
  const top = await db.execute(sql`
    SELECT dst_chunk_id AS id, COUNT(*)::int AS n FROM memory_links
    WHERE workspace_id = ${workspaceId}
    GROUP BY dst_chunk_id ORDER BY n DESC LIMIT 50
  `) as unknown as Array<{ id: string; n: number }>
  const id = uuidv7()
  await db.insert(memorySnapshots).values({
    id, workspaceId,
    snapshotDate: utcDate(),
    chunkCount: chunkCount?.c ?? 0,
    linkCount: linkCount?.c ?? 0,
    tagCount: tagCount?.c ?? 0,
    manifest: { topChunks: top },
    createdAt: Date.now(),
  }).onConflictDoNothing()
  return { id, chunkCount: chunkCount?.c ?? 0, linkCount: linkCount?.c ?? 0, tagCount: tagCount?.c ?? 0 }
}

export async function snapshotList(workspaceId: string, limit = 90): Promise<Array<typeof memorySnapshots.$inferSelect>> {
  return db.select().from(memorySnapshots).where(eq(memorySnapshots.workspaceId, workspaceId))
    .orderBy(desc(memorySnapshots.snapshotDate)).limit(Math.min(limit, 365))
}

export async function snapshotDiff(workspaceId: string, opts: { fromDate: string; toDate?: string }): Promise<{
  chunkDelta: number; linkDelta: number; tagDelta: number; daysApart: number
}> {
  const [from] = await db.select().from(memorySnapshots)
    .where(and(eq(memorySnapshots.workspaceId, workspaceId), eq(memorySnapshots.snapshotDate, opts.fromDate))).limit(1)
  if (!from) throw new Error('from snapshot not found')
  const toDate = opts.toDate ?? utcDate()
  const [to] = await db.select().from(memorySnapshots)
    .where(and(eq(memorySnapshots.workspaceId, workspaceId), eq(memorySnapshots.snapshotDate, toDate))).limit(1)
  if (!to) throw new Error('to snapshot not found')
  const daysApart = Math.round((new Date(toDate).getTime() - new Date(opts.fromDate).getTime()) / (24 * 60 * 60_000))
  return {
    chunkDelta: to.chunkCount - from.chunkCount,
    linkDelta:  to.linkCount  - from.linkCount,
    tagDelta:   to.tagCount   - from.tagCount,
    daysApart,
  }
}

// ─── #18 — Reflective dialogue agent ─────────────────────────────────

/**
 * Socratic agent: asks N follow-up questions to deepen thinking on a topic.
 * Returns the conversation; operator can store as a chat session.
 */
export async function reflectiveDialogue(workspaceId: string, opts: {
  topic: string
  rounds?: number
}): Promise<{ turns: Array<{ role: 'agent' | 'operator-prompt'; content: string }> }> {
  const rounds = Math.max(1, Math.min(opts.rounds ?? 3, 6))
  const { streamChat } = await import('./chat-providers.js')
  const turns: Array<{ role: 'agent' | 'operator-prompt'; content: string }> = []
  let history = `Topic: ${opts.topic}\n\n`
  for (let r = 0; r < rounds; r++) {
    const sys = `You are a Socratic dialogue agent. You ask ONE incisive follow-up question to deepen thinking on the topic. Be specific, surface assumptions, expose tensions. Avoid generic prompts. Output ONLY the question (no preamble).`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: history + `\n\nRound ${r + 1}/${rounds}: ask the next deepening question.` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const question = acc.trim().slice(0, 500)
    turns.push({ role: 'agent', content: question })
    turns.push({ role: 'operator-prompt', content: '(answer + continue with reflective.dialogue again)' })
    history += `\n[Agent ${r + 1}]: ${question}`
  }
  return { turns }
}

// ─── #19 — Daily voice journal ───────────────────────────────────────

export async function voiceJournalCreate(workspaceId: string, opts: {
  transcript: string
  date?: string
  audioPath?: string
  durationSec?: number
}): Promise<{ id: string; chunkId: string }> {
  const date = opts.date ?? utcDate()
  const id = uuidv7()
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `# Voice journal: ${date}\n\n${opts.transcript.slice(0, 8000)}`,
    sourceType: 'event',
    metadata: { kind: 'voice_journal', date },
  })
  await db.insert(voiceJournals).values({
    id, workspaceId, date,
    audioPath: opts.audioPath ?? null,
    transcript: opts.transcript.slice(0, 30_000),
    chunkId: stored.id,
    durationSec: opts.durationSec ?? null,
    status: 'recorded',
    recordedAt: Date.now(),
  })
  // Auto-tag the chunk (fire-and-forget)
  void import('./r147-sb-s-tier.js').then(m => m.tagsExtract(workspaceId, stored.id).catch(() => null))
  return { id, chunkId: stored.id }
}

export async function voiceJournalList(workspaceId: string, limit = 30): Promise<Array<typeof voiceJournals.$inferSelect>> {
  return db.select().from(voiceJournals).where(eq(voiceJournals.workspaceId, workspaceId))
    .orderBy(desc(voiceJournals.date)).limit(Math.min(limit, 365))
}

// ─── #20 — External knowledge import ─────────────────────────────────

/**
 * Import highlights/notes from external sources (Kindle JSON, Readwise
 * export, Pocket, RSS, Twitter saved). Caller passes the source name +
 * an array of items {title, body, url?, tags?}. Each becomes a memory
 * chunk; auto-tagged.
 */
export async function externalImportRun(workspaceId: string, opts: {
  source: 'kindle' | 'readwise' | 'pocket' | 'rss' | 'twitter'
  sourceRef?: string
  items: Array<{ title: string; body: string; url?: string; tags?: string[] }>
}): Promise<{ id: string; imported: number }> {
  const id = uuidv7()
  const now = Date.now()
  await db.insert(externalImports).values({
    id, workspaceId, source: opts.source,
    sourceRef: opts.sourceRef ?? null,
    importedCount: 0, status: 'running',
    importedAt: now,
  })
  const { memoryStore } = await import('./r139-ai-foundation.js')
  let imported = 0
  for (const item of opts.items.slice(0, 5000)) {
    try {
      const stored = await memoryStore(workspaceId, {
        content: `# ${item.title}\n\n${item.body}\n\n${item.url ? `Source: ${item.url}\n` : ''}`,
        sourceType: 'doc',
        metadata: { kind: 'external_import', source: opts.source, tags: item.tags ?? [] },
      })
      // Insert manual tags if provided
      if (item.tags) {
        for (const t of item.tags.slice(0, 10)) {
          await db.execute(sql`
            INSERT INTO memory_tags (workspace_id, chunk_id, tag, source, confidence, created_at)
            VALUES (${workspaceId}, ${stored.id}, ${t.toLowerCase().slice(0, 60)}, 'manual', 1.0, ${Date.now()})
            ON CONFLICT DO NOTHING
          `).catch(() => null)
        }
      }
      imported++
    } catch { /* skip bad item */ }
  }
  await db.update(externalImports).set({ importedCount: imported, status: 'completed' }).where(eq(externalImports.id, id))
  return { id, imported }
}

export async function externalImportList(workspaceId: string, limit = 30): Promise<Array<typeof externalImports.$inferSelect>> {
  return db.select().from(externalImports).where(eq(externalImports.workspaceId, workspaceId))
    .orderBy(desc(externalImports.importedAt)).limit(Math.min(limit, 100))
}

// Suppress unused
void lte
