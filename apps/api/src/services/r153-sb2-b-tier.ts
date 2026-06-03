/**
 * R146.153 — SB2 B-tier: forward-link suggestions, auto-summary rollups
 * per tag, knowledge gap inversion, note merging/splitting, citations.
 */
import { db } from '../db/client.js'
import { memoryChunks, memoryLinks, memoryTags } from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #11 — Forward-link suggestions ──────────────────────────────────

/**
 * Given draft text, find existing memory chunks that would be sensible
 * link targets (semantic similarity). Returns top-N suggested targets
 * with their preview.
 */
export async function linkSuggest(workspaceId: string, opts: { draftText: string; k?: number }): Promise<Array<{ chunkId: string; preview: string; similarity: number; suggestedAlias: string }>> {
  const k = Math.max(1, Math.min(opts.k ?? 5, 20))
  const { memoryRecall } = await import('./r139-ai-foundation.js')
  const hits = await memoryRecall(workspaceId, { query: opts.draftText.slice(0, 2000), k })
  return hits.map(h => ({
    chunkId: h.id,
    preview: h.content.slice(0, 200),
    similarity: h.similarity,
    // Suggested alias = first heading or first 40 chars
    suggestedAlias: (h.content.match(/^#+\s*(.+?)$/m)?.[1] ?? h.content.slice(0, 40)).slice(0, 60),
  }))
}

// ─── #12 — Auto-summary rollups per tag ──────────────────────────────

/**
 * For all chunks under a tag, generate a rolling summary. Caller may
 * persist the result as a new memory chunk (kind: 'tag_rollup').
 */
export async function tagRollup(workspaceId: string, opts: { tag: string; maxChunks?: number }): Promise<{ summary: string; chunkCount: number; rolledUpChunkId?: string }> {
  const maxChunks = Math.max(5, Math.min(opts.maxChunks ?? 30, 100))
  // Find chunks with tag
  const tagRows = await db.select({ chunkId: memoryTags.chunkId }).from(memoryTags)
    .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.tag, opts.tag.toLowerCase())))
    .limit(maxChunks)
  if (tagRows.length === 0) return { summary: '(no chunks with this tag)', chunkCount: 0 }
  const chunkRows = await db.execute(sql`
    SELECT id, LEFT(content, 800) AS preview FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND id = ANY(${tagRows.map(r => r.chunkId)})
    ORDER BY created_at DESC LIMIT ${maxChunks}
  `) as unknown as Array<{ id: string; preview: string }>
  let summary = ''
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Synthesize a rolling summary of all notes on a topic. 300-500 words. Sections: Core ideas · Open questions · Evolving themes. Cite chunk IDs sparingly via [chunkId:short].`
    const body = chunkRows.map(r => `[chunkId:${r.id.slice(0, 8)}]\n${r.preview}`).join('\n\n---\n\n').slice(0, 16000)
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `Topic: ${opts.tag}\n\nNotes:\n${body}` },
    ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
    for await (const ch of gen) summary += ch.delta
  } catch (e) {
    summary = `(rollup unavailable: ${(e as Error).message.slice(0, 100)})`
  }
  // Persist as a memory chunk
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: `# Tag rollup: ${opts.tag}\n\n${summary}`,
    sourceType: 'doc',
    metadata: { kind: 'tag_rollup', tag: opts.tag, chunkCount: chunkRows.length },
  })
  return { summary, chunkCount: chunkRows.length, rolledUpChunkId: stored.id }
}

// ─── #13 — Knowledge gap inversion ───────────────────────────────────

/**
 * Given a concept (tag), find adjacent concepts you have lots of notes
 * about that this concept doesn't link to. Surfaces blind spots.
 */
export async function gapInversion(workspaceId: string, opts: { tag: string; topAdjacent?: number }): Promise<{ tag: string; adjacentMissingLinks: Array<{ tag: string; chunkCount: number; sampleChunkIds: string[] }> }> {
  const topN = Math.max(3, Math.min(opts.topAdjacent ?? 10, 30))
  // Top concepts you have lots of notes about, excluding the target
  const topConcepts = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS n FROM memory_tags
    WHERE workspace_id = ${workspaceId} AND tag != ${opts.tag.toLowerCase()}
    GROUP BY tag ORDER BY n DESC LIMIT 50
  `) as unknown as Array<{ tag: string; n: number }>
  // Chunks under the target tag
  const targetChunks = await db.select({ chunkId: memoryTags.chunkId }).from(memoryTags)
    .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.tag, opts.tag.toLowerCase())))
    .limit(500)
  const targetIds = new Set(targetChunks.map(r => r.chunkId))
  // For each top concept, check whether target chunks reference it
  const adjacentMissingLinks: Array<{ tag: string; chunkCount: number; sampleChunkIds: string[] }> = []
  for (const tc of topConcepts) {
    // Find chunks under tc.tag
    const tcChunks = await db.select({ chunkId: memoryTags.chunkId }).from(memoryTags)
      .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.tag, tc.tag)))
      .limit(50)
    const tcIds = new Set(tcChunks.map(r => r.chunkId))
    // Does any target chunk link to a tc chunk?
    const links = await db.select().from(memoryLinks)
      .where(and(eq(memoryLinks.workspaceId, workspaceId), sql`${memoryLinks.srcChunkId} = ANY(${[...targetIds]})`, sql`${memoryLinks.dstChunkId} = ANY(${[...tcIds]})`))
      .limit(1)
    if (links.length === 0) {
      adjacentMissingLinks.push({
        tag: tc.tag, chunkCount: tcChunks.length,
        sampleChunkIds: tcChunks.slice(0, 3).map(c => c.chunkId),
      })
    }
    if (adjacentMissingLinks.length >= topN) break
  }
  return { tag: opts.tag, adjacentMissingLinks }
}

// ─── #14 — Note merging / splitting ──────────────────────────────────

export async function chunkMerge(workspaceId: string, opts: { keepId: string; mergeId: string; mergedTitle?: string }): Promise<{ ok: boolean; mergedChunkId: string; redirectedLinks: number }> {
  const [keep] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.keepId))).limit(1)
  const [merge] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.mergeId))).limit(1)
  if (!keep || !merge) throw new Error('one or both chunks not found')
  const merged = `${opts.mergedTitle ? `# ${opts.mergedTitle}\n\n` : ''}${keep.content}\n\n---\n\n${merge.content}`
  await db.update(memoryChunks).set({ content: merged.slice(0, 10_000) })
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.keepId)))
  // Redirect links: src or dst = mergeId → keepId
  const updatedOut = await db.update(memoryLinks).set({ srcChunkId: opts.keepId })
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.srcChunkId, opts.mergeId)))
    .returning({ id: memoryLinks.id })
  const updatedIn = await db.update(memoryLinks).set({ dstChunkId: opts.keepId })
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.dstChunkId, opts.mergeId)))
    .returning({ id: memoryLinks.id })
  await db.delete(memoryChunks).where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.mergeId)))
  return { ok: true, mergedChunkId: opts.keepId, redirectedLinks: updatedOut.length + updatedIn.length }
}

export async function chunkSplit(workspaceId: string, opts: { chunkId: string; splitMarker?: string }): Promise<{ ok: boolean; newChunkIds: string[] }> {
  const [chunk] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId))).limit(1)
  if (!chunk) throw new Error('chunk not found')
  const marker = opts.splitMarker ?? '\n## '
  const parts = chunk.content.split(marker).filter(p => p.trim().length > 50)
  if (parts.length < 2) return { ok: false, newChunkIds: [] }
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const newIds: string[] = []
  // Update original to first part; create new for the rest
  await db.update(memoryChunks).set({ content: parts[0]!.slice(0, 10_000) })
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId)))
  for (let i = 1; i < parts.length; i++) {
    const stored = await memoryStore(workspaceId, {
      content: `${marker.trim()} ${parts[i]!.slice(0, 10_000)}`,
      sourceType: 'manual',
      metadata: { kind: 'split_from', parent: opts.chunkId, partIndex: i },
    })
    newIds.push(stored.id)
  }
  return { ok: true, newChunkIds: newIds }
}

// ─── #15 — Citation tracking ─────────────────────────────────────────

const CITE_RE = /\[cite:([^\]]+)\]/g

/**
 * Scan a chunk for [cite:<chunkId>] markers; persist a 'cites' link
 * type to each source chunk. Cites distinct from wiki-links (which are
 * directional concept references).
 */
export async function citationsExtract(workspaceId: string, chunkId: string): Promise<{ extracted: number; cites: string[] }> {
  const [chunk] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, chunkId))).limit(1)
  if (!chunk) return { extracted: 0, cites: [] }
  const cites: string[] = []
  let extracted = 0
  for (const m of chunk.content.matchAll(CITE_RE)) {
    const target = (m[1] ?? '').trim()
    if (!target) continue
    const [dst] = await db.execute(sql`
      SELECT id FROM memory_chunks WHERE workspace_id = ${workspaceId}
        AND (id = ${target} OR id LIKE ${`${target}%`}) LIMIT 1
    `) as unknown as Array<{ id: string }>
    if (!dst) continue
    cites.push(dst.id)
    await db.insert(memoryLinks).values({
      id: uuidv7(), workspaceId,
      srcChunkId: chunkId, dstChunkId: dst.id,
      linkType: 'cite',
      context: chunk.content.slice(Math.max(0, m.index! - 40), Math.min(chunk.content.length, m.index! + 40)),
      createdAt: Date.now(),
    }).onConflictDoNothing().catch(() => null)
    extracted++
  }
  return { extracted, cites }
}

export async function citationsForChunk(workspaceId: string, chunkId: string): Promise<Array<{ citedChunkId: string; context: string | null; preview: string }>> {
  const links = await db.select().from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.srcChunkId, chunkId), eq(memoryLinks.linkType, 'cite')))
    .limit(100)
  const out: Array<{ citedChunkId: string; context: string | null; preview: string }> = []
  for (const l of links) {
    const [c] = await db.select({ content: memoryChunks.content }).from(memoryChunks)
      .where(eq(memoryChunks.id, l.dstChunkId)).limit(1)
    out.push({ citedChunkId: l.dstChunkId, context: l.context, preview: (c?.content ?? '').slice(0, 200) })
  }
  return out
}
