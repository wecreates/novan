/**
 * R146.147 — Second-brain S-tier: wiki-links, daily notes, auto-tagging,
 * outline hierarchy, smart inbox capture.
 */
import { db } from '../db/client.js'
import { memoryLinks, dailyNotes, memoryTags, memoryOutline, inboxItems, memoryChunks } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── #1 — Bidirectional wiki-links ───────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g

/**
 * Scan a chunk's content for [[wiki-link]] patterns, resolve each to a
 * memory chunk (by exact content match or by id), persist directed edges.
 * Idempotent: existing edges are upserted via unique constraint.
 */
export async function linksExtract(workspaceId: string, srcChunkId: string): Promise<{ extracted: number; unresolved: string[] }> {
  const [src] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, srcChunkId))).limit(1)
  if (!src) return { extracted: 0, unresolved: [] }
  const unresolved: string[] = []
  let extracted = 0
  const matches = [...src.content.matchAll(WIKILINK_RE)]
  for (const m of matches) {
    const target = (m[1] ?? '').trim()
    if (!target) continue
    // Resolve by exact substring match on content (first 240 chars), or by id prefix
    const [dst] = await db.execute(sql`
      SELECT id FROM memory_chunks
      WHERE workspace_id = ${workspaceId}
        AND (id = ${target} OR LEFT(content, 240) ILIKE ${`%${target}%`})
      LIMIT 1
    `) as unknown as Array<{ id: string }>
    if (!dst) { unresolved.push(target); continue }
    const context = src.content.slice(Math.max(0, m.index! - 60), Math.min(src.content.length, m.index! + 60))
    await db.insert(memoryLinks).values({
      id: uuidv7(), workspaceId,
      srcChunkId, dstChunkId: dst.id,
      linkType: 'wiki', context,
      createdAt: Date.now(),
    }).onConflictDoNothing().catch(() => null)
    extracted++
  }
  return { extracted, unresolved }
}

export async function linksForward(workspaceId: string, chunkId: string): Promise<Array<{ dstChunkId: string; linkType: string; context: string | null; preview: string }>> {
  const links = await db.select().from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.srcChunkId, chunkId)))
    .limit(200)
  const out: Array<{ dstChunkId: string; linkType: string; context: string | null; preview: string }> = []
  for (const l of links) {
    const [c] = await db.select({ content: memoryChunks.content })
      .from(memoryChunks).where(eq(memoryChunks.id, l.dstChunkId)).limit(1)
    out.push({ dstChunkId: l.dstChunkId, linkType: l.linkType, context: l.context, preview: (c?.content ?? '').slice(0, 200) })
  }
  return out
}

export async function linksBacklinks(workspaceId: string, chunkId: string): Promise<Array<{ srcChunkId: string; linkType: string; context: string | null; preview: string }>> {
  const links = await db.select().from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.dstChunkId, chunkId)))
    .limit(200)
  const out: Array<{ srcChunkId: string; linkType: string; context: string | null; preview: string }> = []
  for (const l of links) {
    const [c] = await db.select({ content: memoryChunks.content })
      .from(memoryChunks).where(eq(memoryChunks.id, l.srcChunkId)).limit(1)
    out.push({ srcChunkId: l.srcChunkId, linkType: l.linkType, context: l.context, preview: (c?.content ?? '').slice(0, 200) })
  }
  return out
}

// ─── #2 — Daily notes ────────────────────────────────────────────────

function utcDate(t = Date.now()): string {
  const d = new Date(t)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return utcDate(d.getTime())
}

export async function dailyNoteFor(workspaceId: string, date?: string): Promise<{ date: string; chunkId: string; created: boolean }> {
  const d = date ?? utcDate()
  const [existing] = await db.select().from(dailyNotes)
    .where(and(eq(dailyNotes.workspaceId, workspaceId), eq(dailyNotes.date, d))).limit(1)
  if (existing) return { date: d, chunkId: existing.chunkId, created: false }
  // Create the underlying memory chunk
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const prev = addDays(d, -1)
  const next = addDays(d, 1)
  const stub = `# ${d}\n\n[[${prev}]] ← yesterday  ·  tomorrow → [[${next}]]\n\n`
  const m = await memoryStore(workspaceId, { content: stub, sourceType: 'manual', metadata: { kind: 'daily_note', date: d } })
  await db.insert(dailyNotes).values({
    workspaceId, date: d, chunkId: m.id,
    prevDate: prev, nextDate: next,
    createdAt: Date.now(),
  })
  return { date: d, chunkId: m.id, created: true }
}

export async function dailyNoteList(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof dailyNotes.$inferSelect>> {
  return db.select().from(dailyNotes).where(eq(dailyNotes.workspaceId, workspaceId))
    .orderBy(desc(dailyNotes.date)).limit(Math.min(opts.limit ?? 30, 200))
}

// ─── #3 — Concept extraction + auto-tagging ──────────────────────────

export async function tagsExtract(workspaceId: string, chunkId: string): Promise<{ tags: string[]; entities: string[] }> {
  const [chunk] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, chunkId))).limit(1)
  if (!chunk) return { tags: [], entities: [] }
  let tags: string[] = []
  let entities: string[] = []
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Extract concepts + named entities. Return STRICT JSON: {"tags":["..."],"entities":["..."]}. Tags = 3-7 low-cardinality concepts (lowercase, hyphenated). Entities = specific named things (people, places, orgs, products).`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: chunk.content.slice(0, 6000) },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { tags?: string[]; entities?: string[] }
      tags = (parsed.tags ?? []).slice(0, 8).map(t => String(t).toLowerCase().slice(0, 60))
      entities = (parsed.entities ?? []).slice(0, 15).map(e => String(e).slice(0, 80))
    }
  } catch { /* leave empty */ }
  const now = Date.now()
  for (const t of tags) {
    await db.insert(memoryTags).values({
      workspaceId, chunkId, tag: t, source: 'auto', confidence: 0.9, createdAt: now,
    }).onConflictDoNothing().catch(() => null)
  }
  for (const e of entities) {
    await db.insert(memoryTags).values({
      workspaceId, chunkId, tag: `@${e}`, source: 'auto', confidence: 0.85, createdAt: now,
    }).onConflictDoNothing().catch(() => null)
  }
  return { tags, entities }
}

export async function tagsForChunk(workspaceId: string, chunkId: string): Promise<Array<{ tag: string; source: string; confidence: number }>> {
  const rows = await db.select().from(memoryTags)
    .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.chunkId, chunkId)))
    .limit(100)
  return rows.map(r => ({ tag: r.tag, source: r.source, confidence: r.confidence }))
}

export async function chunksWithTag(workspaceId: string, tag: string, limit = 50): Promise<Array<{ chunkId: string; content: string; confidence: number }>> {
  const rows = await db.select({ chunkId: memoryTags.chunkId, confidence: memoryTags.confidence, content: memoryChunks.content })
    .from(memoryTags)
    .leftJoin(memoryChunks, eq(memoryTags.chunkId, memoryChunks.id))
    .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.tag, tag.toLowerCase())))
    .limit(Math.min(limit, 200))
  return rows.filter(r => r.content !== null).map(r => ({ chunkId: r.chunkId, content: (r.content ?? '').slice(0, 400), confidence: r.confidence }))
}

// ─── #4 — Note hierarchy / outlining ─────────────────────────────────

export async function outlineSetParent(workspaceId: string, opts: { chunkId: string; parentChunkId: string | null; sortOrder?: number }): Promise<{ ok: boolean }> {
  await db.insert(memoryOutline).values({
    workspaceId, chunkId: opts.chunkId,
    parentChunkId: opts.parentChunkId,
    sortOrder: opts.sortOrder ?? 0,
    collapsed: false,
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [memoryOutline.workspaceId, memoryOutline.chunkId],
    set: { parentChunkId: opts.parentChunkId, sortOrder: opts.sortOrder ?? 0, updatedAt: Date.now() },
  })
  return { ok: true }
}

export async function outlineChildren(workspaceId: string, parentChunkId: string | null): Promise<Array<{ chunkId: string; sortOrder: number; collapsed: boolean; preview: string }>> {
  const rows = await db.select({ chunkId: memoryOutline.chunkId, sortOrder: memoryOutline.sortOrder, collapsed: memoryOutline.collapsed, content: memoryChunks.content })
    .from(memoryOutline)
    .leftJoin(memoryChunks, eq(memoryOutline.chunkId, memoryChunks.id))
    .where(parentChunkId
      ? and(eq(memoryOutline.workspaceId, workspaceId), eq(memoryOutline.parentChunkId, parentChunkId))
      : and(eq(memoryOutline.workspaceId, workspaceId), sql`${memoryOutline.parentChunkId} IS NULL`))
    .orderBy(memoryOutline.sortOrder)
    .limit(200)
  return rows.map(r => ({ chunkId: r.chunkId, sortOrder: r.sortOrder, collapsed: r.collapsed, preview: (r.content ?? '').slice(0, 200) }))
}

export async function outlineToggleCollapse(workspaceId: string, chunkId: string): Promise<{ ok: boolean; collapsed: boolean }> {
  const [row] = await db.select().from(memoryOutline)
    .where(and(eq(memoryOutline.workspaceId, workspaceId), eq(memoryOutline.chunkId, chunkId))).limit(1)
  if (!row) return { ok: false, collapsed: false }
  const next = !row.collapsed
  await db.update(memoryOutline).set({ collapsed: next, updatedAt: Date.now() })
    .where(and(eq(memoryOutline.workspaceId, workspaceId), eq(memoryOutline.chunkId, chunkId)))
  return { ok: true, collapsed: next }
}

// ─── #5 — Smart inbox capture ────────────────────────────────────────

export async function inboxCapture(workspaceId: string, opts: {
  kind: 'url' | 'voice' | 'photo' | 'text' | 'note'
  rawContent: string
  sourceUrl?: string
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(inboxItems).values({
    id, workspaceId,
    kind: opts.kind,
    rawContent: opts.rawContent.slice(0, 50_000),
    sourceUrl: opts.sourceUrl ?? null,
    processed: false,
    capturedAt: Date.now(),
  })
  return { id }
}

export async function inboxList(workspaceId: string, opts: { processed?: boolean; limit?: number } = {}): Promise<Array<typeof inboxItems.$inferSelect>> {
  const where = typeof opts.processed === 'boolean'
    ? and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.processed, opts.processed))
    : eq(inboxItems.workspaceId, workspaceId)
  return db.select().from(inboxItems).where(where).orderBy(desc(inboxItems.capturedAt)).limit(Math.min(opts.limit ?? 30, 200))
}

/**
 * Process unprocessed inbox items: extract title + summary + tags via LLM,
 * store as memory chunk + auto-tag, mark processed.
 */
export async function inboxProcessTick(workspaceId: string, limit = 5): Promise<{ processed: number }> {
  const pending = await db.select().from(inboxItems)
    .where(and(eq(inboxItems.workspaceId, workspaceId), eq(inboxItems.processed, false)))
    .orderBy(desc(inboxItems.capturedAt)).limit(Math.max(1, Math.min(limit, 20)))
  let processed = 0
  const { memoryStore } = await import('./r139-ai-foundation.js')
  for (const item of pending) {
    let title = item.rawContent.slice(0, 80)
    let summary = item.rawContent.slice(0, 500)
    try {
      const { streamChat } = await import('./chat-providers.js')
      const sys = `Process inbox item. Return STRICT JSON: {"title":"<60 chars>","summary":"<200 chars>","kind_inferred":"<note|task|idea|reference>"}.`
      const gen = streamChat(workspaceId, [
        { role: 'system', content: sys },
        { role: 'user',   content: `Kind: ${item.kind}\nSource: ${item.sourceUrl ?? '(none)'}\nContent: ${item.rawContent.slice(0, 6000)}` },
      ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      const m = acc.match(/\{[\s\S]*\}/)
      if (m) {
        const parsed = JSON.parse(m[0]) as { title?: string; summary?: string }
        title = (parsed.title ?? title).slice(0, 80)
        summary = (parsed.summary ?? summary).slice(0, 500)
      }
    } catch { /* leave raw */ }
    const stored = await memoryStore(workspaceId, {
      content: `# ${title}\n\n${summary}\n\n${item.sourceUrl ? `Source: ${item.sourceUrl}\n\n` : ''}---\n${item.rawContent.slice(0, 4000)}`,
      sourceType: 'event',
      sourceId: item.id,
      metadata: { from_inbox: true, kind: item.kind },
    })
    await db.update(inboxItems).set({
      processed: true, processedChunkId: stored.id,
      extracted: { title, summary },
      processedAt: Date.now(),
    }).where(eq(inboxItems.id, item.id))
    // Auto-tag
    await tagsExtract(workspaceId, stored.id).catch(() => null)
    processed++
  }
  return { processed }
}
