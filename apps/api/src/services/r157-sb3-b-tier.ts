/**
 * R146.157 — SB3 B-tier: inline rewrite, tone consistency checker,
 * auto-bibliography, note "borrow" (structural template), bulk actions.
 */
import { db } from '../db/client.js'
import { memoryChunks, memoryTags, memoryLinks } from '../db/schema.js'
import { and, eq, sql } from 'drizzle-orm'

// ─── #11 — Inline rewrite ────────────────────────────────────────────

export async function inlineRewrite(workspaceId: string, opts: {
  text: string
  style: 'concise' | 'honest' | 'formal' | 'specific' | 'gentle' | 'punchy' | 'plain'
  keepLength?: boolean
}): Promise<{ rewritten: string }> {
  const instructions: Record<string, string> = {
    concise: 'Cut redundancy. Same content, ~40% fewer words.',
    honest:  'Strip hedging, qualifiers, weasel words. Say it directly.',
    formal:  'Match a formal business register. No contractions. No slang.',
    specific:'Replace vague nouns/verbs with concrete ones. Cite a number or example wherever possible.',
    gentle:  'Same content, softer. Add care without losing the point.',
    punchy:  'Short sentences. Strong verbs. Lead with the conclusion.',
    plain:   'Plain English. No jargon. Explain as if to a smart non-expert.',
  }
  const instr = instructions[opts.style]
  if (!instr) throw new Error(`unknown style. Available: ${Object.keys(instructions).join(', ')}`)
  const { streamChat } = await import('./chat-providers.js')
  const sys = `Rewrite the user's text. Rule: ${instr}${opts.keepLength ? ' Keep length similar.' : ''} Output ONLY the rewritten text — no preface, no quotes.`
  const gen = streamChat(workspaceId, [
    { role: 'system', content: sys },
    { role: 'user',   content: opts.text.slice(0, 8000) },
  ], { taskType: 'other' } as Parameters<typeof streamChat>[2])
  let acc = ''
  for await (const ch of gen) acc += ch.delta
  return { rewritten: acc.trim() }
}

// ─── #12 — Tone consistency checker ──────────────────────────────────

/**
 * Sample recent chunks for baseline tone; score current chunk against
 * baseline. Returns a drift score 0..1 + LLM explanation.
 */
export async function toneCheck(workspaceId: string, opts: { chunkId: string }): Promise<{ drift: number; baseline: string; explanation: string }> {
  const [target] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.chunkId))).limit(1)
  if (!target) throw new Error('chunk not found')
  // Pull baseline: 10 most-recent chunks excluding target
  const baselineRows = await db.execute(sql`
    SELECT LEFT(content, 600) AS preview FROM memory_chunks
    WHERE workspace_id = ${workspaceId} AND id != ${opts.chunkId}
    ORDER BY created_at DESC LIMIT 10
  `) as unknown as Array<{ preview: string }>
  const baselineText = baselineRows.map(r => r.preview).join('\n---\n').slice(0, 8000)
  let drift = 0, explanation = ''
  let baselineSummary = '(insufficient baseline)'
  try {
    const { streamChat } = await import('./chat-providers.js')
    const sys = `Compare a SUBJECT note to a BASELINE of recent notes by the same operator. Output STRICT JSON: {"baselineSummary":"<one-sentence baseline tone>","drift":0..1 (0=on-brand, 1=very off),"explanation":"<one sentence>"}.`
    const gen = streamChat(workspaceId, [
      { role: 'system', content: sys },
      { role: 'user',   content: `BASELINE:\n${baselineText}\n\nSUBJECT:\n${target.content.slice(0, 4000)}` },
    ], { taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
    let acc = ''
    for await (const ch of gen) acc += ch.delta
    const m = acc.match(/\{[\s\S]*\}/)
    if (m) {
      const parsed = JSON.parse(m[0]) as { baselineSummary?: string; drift?: number; explanation?: string }
      drift = Math.max(0, Math.min(parsed.drift ?? 0, 1))
      explanation = String(parsed.explanation ?? '').slice(0, 300)
      baselineSummary = String(parsed.baselineSummary ?? '').slice(0, 200)
    }
  } catch { /* defaults */ }
  return { drift, baseline: baselineSummary, explanation }
}

// ─── #13 — Auto-bibliography ─────────────────────────────────────────

export async function bibliographyFor(workspaceId: string, chunkId: string): Promise<{ entries: Array<{ refNum: number; chunkId: string; title: string; preview: string }> }> {
  // Find all cite-type or wiki-type outgoing links from this chunk
  const links = await db.select().from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, workspaceId), eq(memoryLinks.srcChunkId, chunkId)))
    .limit(200)
  const entries: Array<{ refNum: number; chunkId: string; title: string; preview: string }> = []
  let refNum = 1
  for (const l of links) {
    const [c] = await db.select({ content: memoryChunks.content }).from(memoryChunks).where(eq(memoryChunks.id, l.dstChunkId)).limit(1)
    if (!c) continue
    const title = (c.content.match(/^#+\s*(.+?)$/m)?.[1] ?? c.content.slice(0, 60)).slice(0, 120)
    entries.push({ refNum, chunkId: l.dstChunkId, title, preview: c.content.slice(0, 200) })
    refNum++
  }
  return { entries }
}

// ─── #14 — Note "borrow" (structural template) ───────────────────────

/**
 * Extract the structure (headings + bullet skeleton) of a chunk and
 * create a new chunk with that skeleton as a starting point.
 */
export async function noteBorrowStructure(workspaceId: string, opts: { fromChunkId: string; newTitle?: string }): Promise<{ newChunkId: string }> {
  const [src] = await db.select().from(memoryChunks)
    .where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, opts.fromChunkId))).limit(1)
  if (!src) throw new Error('source chunk not found')
  // Extract headings + first-level bullets
  const lines = src.content.split('\n')
  const skeleton: string[] = []
  for (const line of lines) {
    if (/^#+\s/.test(line)) skeleton.push(line)
    else if (/^\s*[-*]\s/.test(line)) skeleton.push(line.replace(/[-*]\s.+$/, '- '))
  }
  let body = `# ${opts.newTitle ?? 'New note (borrowed structure)'}\n\n${skeleton.join('\n')}`
  const { memoryStore } = await import('./r139-ai-foundation.js')
  const stored = await memoryStore(workspaceId, {
    content: body,
    sourceType: 'manual',
    metadata: { kind: 'borrowed_structure', source: opts.fromChunkId },
  })
  return { newChunkId: stored.id }
}

// ─── #15 — Bulk actions ──────────────────────────────────────────────

/**
 * Add/remove tags on chunks matching a search query.
 * For safety: dryRun=true by default unless explicitly false.
 */
export async function bulkRetag(workspaceId: string, opts: { query: string; addTags?: string[]; removeTags?: string[]; dryRun?: boolean }): Promise<{ matched: number; added: number; removed: number; sample: Array<{ chunkId: string; preview: string }> }> {
  const dryRun = opts.dryRun !== false
  const { knowledgeSearch } = await import('./r149-sb-b-tier.js')
  const matches = await knowledgeSearch(workspaceId, opts.query, 500)
  let added = 0, removed = 0
  if (!dryRun) {
    const now = Date.now()
    for (const m of matches) {
      for (const t of opts.addTags ?? []) {
        await db.execute(sql`
          INSERT INTO memory_tags (workspace_id, chunk_id, tag, source, confidence, created_at)
          VALUES (${workspaceId}, ${m.chunkId}, ${t.toLowerCase().slice(0, 60)}, 'manual', 1.0, ${now})
          ON CONFLICT DO NOTHING
        `).catch(() => null)
        added++
      }
      for (const t of opts.removeTags ?? []) {
        await db.delete(memoryTags)
          .where(and(eq(memoryTags.workspaceId, workspaceId), eq(memoryTags.chunkId, m.chunkId), eq(memoryTags.tag, t.toLowerCase())))
          .catch(() => null)
        removed++
      }
    }
  }
  return {
    matched: matches.length, added, removed,
    sample: matches.slice(0, 10).map(m => ({ chunkId: m.chunkId, preview: m.preview })),
  }
}

export async function bulkDelete(workspaceId: string, opts: { query: string; confirm: 'DELETE' | string }): Promise<{ deleted: number; sample: Array<{ chunkId: string; preview: string }> }> {
  if (opts.confirm !== 'DELETE') {
    const { knowledgeSearch } = await import('./r149-sb-b-tier.js')
    const matches = await knowledgeSearch(workspaceId, opts.query, 500)
    return { deleted: 0, sample: matches.slice(0, 10).map(m => ({ chunkId: m.chunkId, preview: m.preview })) }
  }
  const { knowledgeSearch } = await import('./r149-sb-b-tier.js')
  const matches = await knowledgeSearch(workspaceId, opts.query, 500)
  let deleted = 0
  for (const m of matches) {
    await db.delete(memoryChunks).where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, m.chunkId))).catch(() => null)
    deleted++
  }
  return { deleted, sample: matches.slice(0, 10).map(m => ({ chunkId: m.chunkId, preview: m.preview })) }
}
