/**
 * R146.144 — A-tier round 2 (features 26-30):
 * Cross-model consensus voting, streaming transform chain, prompt
 * regression bisection, embedding dedup, speculative output preview.
 */
import { db } from '../db/client.js'
import { memoryChunks, promptEvalRuns } from '../db/schema.js'
import { and, eq, desc, sql } from 'drizzle-orm'

// ─── #26 — Cross-model consensus voting ──────────────────────────────

/**
 * Query the same prompt across N providers (sequentially via existing
 * fallback chain — caller passes preferred providers). Take majority
 * answer for classification/factual tasks.
 */
export async function consensusVote(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  providers: string[]   // e.g. ['anthropic', 'openai', 'gemini']
  parseAs?: 'string' | 'json' | 'boolean'
}): Promise<{ winner: unknown; votes: Array<{ provider: string; answer: unknown }>; agreement: number }> {
  const { streamChat } = await import('./chat-providers.js')
  const votes: Array<{ provider: string; answer: unknown }> = []
  for (const provider of opts.providers.slice(0, 5)) {
    try {
      const gen = streamChat(workspaceId, opts.messages, { preferProvider: provider, taskType: 'other', suppressQualityBar: true } as Parameters<typeof streamChat>[2])
      let acc = ''
      for await (const ch of gen) acc += ch.delta
      const answer = opts.parseAs === 'boolean' ? /\btrue\b/i.test(acc) :
                     opts.parseAs === 'json'    ? (acc.match(/\{[\s\S]*\}/) ? JSON.parse(acc.match(/\{[\s\S]*\}/)![0]) : null) :
                                                   acc.trim().slice(0, 4000)
      votes.push({ provider, answer })
    } catch (e) {
      votes.push({ provider, answer: { error: (e as Error).message.slice(0, 200) } })
    }
  }
  // Tally by stringified answer
  const tally = new Map<string, { count: number; value: unknown }>()
  for (const v of votes) {
    const key = JSON.stringify(v.answer)
    const cur = tally.get(key) ?? { count: 0, value: v.answer }
    cur.count++
    tally.set(key, cur)
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1].count - a[1].count)
  const winner = sorted[0]?.[1].value
  const topCount = sorted[0]?.[1].count ?? 0
  const agreement = votes.length > 0 ? topCount / votes.length : 0
  return { winner, votes, agreement }
}

// ─── #27 — Streaming transform chain ─────────────────────────────────

/**
 * Apply multiple transforms in sequence per delta. Caller passes named
 * transforms ['translate:es', 'censor_pii', 'strip_html']. Each is
 * resolved via a registry; unknown names pass through unchanged.
 */
type TransformFn = (delta: string) => Promise<string> | string

const TRANSFORM_REGISTRY: Record<string, TransformFn> = {
  uppercase:  (d) => d.toUpperCase(),
  lowercase:  (d) => d.toLowerCase(),
  strip_html: (d) => d.replace(/<[^>]+>/g, ''),
  censor_pii: (d) => d
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<SSN>')
    .replace(/\b\d{16}\b/g, '<CARD>')
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, '<EMAIL>'),
  trim:       (d) => d.replace(/\s+/g, ' '),
}

export async function transformChain(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  transforms: string[]
}): Promise<{ text: string; transforms: string[]; missing: string[] }> {
  const fns: TransformFn[] = []
  const missing: string[] = []
  for (const t of opts.transforms.slice(0, 10)) {
    const fn = TRANSFORM_REGISTRY[t]
    if (fn) fns.push(fn)
    else { missing.push(t); fns.push((d) => d) }
  }
  const { streamChat } = await import('./chat-providers.js')
  const gen = streamChat(workspaceId, opts.messages, { taskType: 'chat' } as Parameters<typeof streamChat>[2])
  let text = ''
  for await (const ch of gen) {
    let delta = ch.delta
    for (const fn of fns) delta = await fn(delta)
    text += delta
  }
  return { text, transforms: opts.transforms, missing }
}

// ─── #28 — Prompt regression bisection ───────────────────────────────

/**
 * When an eval suite drops below baseline, bisect through prompt
 * versions to find the version that regressed.
 *
 * Skeleton: bisects the existing prompt_eval_runs history. Returns the
 * version with the largest score drop vs its predecessor.
 */
export async function evalBisect(workspaceId: string, promptKey: string): Promise<{ regressedAt: string | null; scoreDelta: number; history: Array<{ version: string | null; score: number; ranAt: number }> }> {
  const runs = await db.select().from(promptEvalRuns)
    .where(and(eq(promptEvalRuns.workspaceId, workspaceId), eq(promptEvalRuns.promptKey, promptKey)))
    .orderBy(desc(promptEvalRuns.ranAt))
    .limit(50)
  if (runs.length < 2) return { regressedAt: null, scoreDelta: 0, history: runs.map(r => ({ version: r.promptVersion, score: r.score, ranAt: r.ranAt })) }
  let worstDrop = 0
  let regressedAt: string | null = null
  // Walk newest → oldest; score drop = newer - older (negative = regression)
  for (let i = 0; i < runs.length - 1; i++) {
    const newer = runs[i]!
    const older = runs[i + 1]!
    const drop = newer.score - older.score
    if (drop < worstDrop) {
      worstDrop = drop
      regressedAt = newer.promptVersion
    }
  }
  return {
    regressedAt,
    scoreDelta: worstDrop,
    history: runs.slice().reverse().map(r => ({ version: r.promptVersion, score: r.score, ranAt: r.ranAt })),
  }
}

// ─── #29 — Embedding-based dedup ─────────────────────────────────────

const DEDUP_THRESHOLD = 0.97

/**
 * Scan memory chunks; for each, find near-duplicates (cosine sim ≥
 * threshold) and mark all but the oldest as superseded (delete or merge).
 *
 * Returns count of removed duplicates.
 */
export async function memoryDedup(workspaceId: string, opts: { dryRun?: boolean; limit?: number } = {}): Promise<{ scanned: number; duplicates: Array<{ keptId: string; removedId: string; similarity: number }>; removed: number }> {
  const limit = Math.min(opts.limit ?? 200, 1000)
  const rows = await db.select().from(memoryChunks)
    .where(eq(memoryChunks.workspaceId, workspaceId))
    .orderBy(memoryChunks.createdAt)
    .limit(limit)
  const seen = new Set<string>()
  const duplicates: Array<{ keptId: string; removedId: string; similarity: number }> = []
  for (const r of rows) {
    if (seen.has(r.id) || !r.embedding) continue
    seen.add(r.id)
    // Find near-duplicates
    const sim = await db.execute(sql`
      SELECT id, 1 - (embedding <=> ${sql.raw(`'[${(r.embedding as number[]).join(',')}]'::vector`)}) AS sim
      FROM memory_chunks
      WHERE workspace_id = ${workspaceId} AND id != ${r.id} AND embedding IS NOT NULL
        AND created_at > ${r.createdAt}
      ORDER BY embedding <=> ${sql.raw(`'[${(r.embedding as number[]).join(',')}]'::vector`)}
      LIMIT 5
    `) as unknown as Array<{ id: string; sim: number }>
    for (const s of sim) {
      if (s.sim >= DEDUP_THRESHOLD && !seen.has(s.id)) {
        duplicates.push({ keptId: r.id, removedId: s.id, similarity: s.sim })
        seen.add(s.id)
      }
    }
  }
  let removed = 0
  if (!opts.dryRun) {
    for (const d of duplicates) {
      await db.delete(memoryChunks).where(and(eq(memoryChunks.workspaceId, workspaceId), eq(memoryChunks.id, d.removedId))).catch(() => null)
      removed++
    }
  }
  return { scanned: rows.length, duplicates, removed }
}

// ─── #30 — Speculative output preview ────────────────────────────────

/**
 * Stream first N tokens of LLM output as a preview; caller can cancel
 * before the full response runs. Returns preview + abort token.
 *
 * Honest scope: this uses a fixed delta-count budget, not true
 * speculative decoding. Useful as a UI affordance for "do you want
 * the full version?"
 */
export async function speculativePreview(workspaceId: string, opts: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  previewDeltas?: number
}): Promise<{ preview: string; deltaCount: number; sessionId: string }> {
  const target = Math.max(5, Math.min(opts.previewDeltas ?? 30, 200))
  const { startInterruptibleSession } = await import('./r142-ai-c-tier.js')
  const { sessionId, signal } = startInterruptibleSession()
  const { streamChat } = await import('./chat-providers.js')
  const gen = streamChat(workspaceId, opts.messages, { taskType: 'chat', signal } as Parameters<typeof streamChat>[2])
  let preview = ''
  let deltaCount = 0
  for await (const ch of gen) {
    preview += ch.delta
    deltaCount++
    if (deltaCount >= target) break
  }
  return { preview, deltaCount, sessionId }
}
