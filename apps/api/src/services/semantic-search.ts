/**
 * semantic-search.ts — Tier-4: semantic-ish search over reasoning chains.
 *
 * Honest scope: uses a deterministic hash-based bag-of-tokens vector
 * (256 dim). Captures lexical co-occurrence — NOT true semantic
 * understanding. Good for "find chains mentioning provider migration"
 * without LLM cost. Documented as such.
 *
 * Why not real embeddings? Cost. Every chain would need an OpenAI call.
 * The existing embeddings.ts is for pgvector content embeddings on user
 * content, not internal platform state. Hash-bag is appropriate for
 * platform-internal search.
 */
import { db } from '../db/client.js'
import { reasoningChains, chainEmbeddings } from '../db/schema.js'
import { and, eq, desc, inArray, gte } from 'drizzle-orm'
import { createHash } from 'node:crypto'

const DIM = 256

/** Hash a token to a slot index in [0, DIM). */
function slot(token: string): number {
  const h = createHash('sha256').update(token).digest()
  return ((h[0]! << 8) | h[1]!) % DIM
}

/** Tokenize: lowercase, alphanum split, drop short tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
}

/** Build a normalized hash-bag vector. */
export function embed(text: string): number[] {
  const v = new Array(DIM).fill(0)
  for (const tok of tokenize(text)) v[slot(tok)] += 1
  // L2 normalize
  let mag = 0
  for (const x of v) mag += x * x
  mag = Math.sqrt(mag) || 1
  return v.map(x => x / mag)
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < DIM; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot   // both are unit vectors
}

/** Index a single chain (idempotent on chain_id). */
export async function indexChain(workspaceId: string, chainId: string, text: string, sourceKind?: string): Promise<void> {
  const vector = embed(text)
  await db.insert(chainEmbeddings).values({
    chainId, workspaceId,
    vector: JSON.stringify(vector), dim: DIM,
    sourceKind: sourceKind ?? null,
    createdAt: Date.now(),
  }).onConflictDoNothing().catch((e: Error) => { console.error('[semantic-search]', e.message); return null })
}

/** Backfill: index any chains in the last N days that lack an embedding. */
export async function backfillRecent(workspaceId: string, days = 30): Promise<{ indexed: number }> {
  const since = Date.now() - days * 24 * 60 * 60_000
  const chains = await db.select({
    id: reasoningChains.id, decision: reasoningChains.decision, kind: reasoningChains.kind,
  }).from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), gte(reasoningChains.createdAt, since)))
    .limit(2000)
    .catch(() => [])
  if (chains.length === 0) return { indexed: 0 }
  const existing = await db.select({ chainId: chainEmbeddings.chainId }).from(chainEmbeddings)
    .where(and(eq(chainEmbeddings.workspaceId, workspaceId), inArray(chainEmbeddings.chainId, chains.map(c => c.id))))
    .catch(() => [])
  const have = new Set(existing.map(e => e.chainId))
  let indexed = 0
  for (const c of chains) {
    if (have.has(c.id)) continue
    await indexChain(workspaceId, c.id, c.decision, c.kind)
    indexed++
  }
  return { indexed }
}

export interface SearchResult {
  chainId:   string
  score:     number
  decision:  string
  kind:      string
  createdAt: number
  outcomeMatched: boolean | null
}

export async function search(workspaceId: string, query: string, opts?: { limit?: number; minScore?: number }): Promise<SearchResult[]> {
  const qvec = embed(query)
  const rows = await db.select().from(chainEmbeddings)
    .where(eq(chainEmbeddings.workspaceId, workspaceId))
    .limit(5000).catch(() => [])
  const scored = rows.map(r => {
    let vec: number[]
    try { vec = JSON.parse(r.vector) } catch { return null }
    return { chainId: r.chainId, score: cosine(qvec, vec) }
  }).filter(Boolean) as Array<{ chainId: string; score: number }>
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, opts?.limit ?? 20).filter(s => s.score >= (opts?.minScore ?? 0.05))
  if (top.length === 0) return []
  const chains = await db.select().from(reasoningChains)
    .where(inArray(reasoningChains.id, top.map(t => t.chainId)))
    .catch(() => [])
  const chainMap = new Map(chains.map(c => [c.id, c]))
  const out: SearchResult[] = []
  for (const t of top) {
    const c = chainMap.get(t.chainId)
    if (!c) continue
    out.push({
      chainId: t.chainId, score: Number(t.score.toFixed(4)),
      decision: c.decision, kind: c.kind, createdAt: c.createdAt,
      outcomeMatched: c.outcomeMatched,
    })
  }
  return out
}
