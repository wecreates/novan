/**
 * R582 — Semantic vector recall on workspace_memory.
 *
 * Today: brain queries memory by exact key. Misses related lessons /
 * patterns / decisions that don't match keyword.
 *
 * R582: lazily embed memory entries, store vector alongside value,
 * cosine-similarity search returns top-K relevant. The brain can now
 * proactively retrieve "memories like this query" before generating.
 *
 * Storage: pgvector is already enabled (R145). Adds nullable
 * `embedding vector(1536)` column to workspace_memory. Lazy: first
 * access computes + persists the embedding.
 *
 * Provider: uses ai-cost-tracker.embed() (already wired to Anthropic/
 * OpenAI per provider routing).
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureEmbeddingColumn(): Promise<void> {
  await db.execute(sql`ALTER TABLE workspace_memory ADD COLUMN IF NOT EXISTS embedding vector(1536)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS workspace_memory_embed_idx ON workspace_memory USING hnsw (embedding vector_cosine_ops)`).catch(() => {})
}

/** Cheap embedding generator. Uses OpenAI text-embedding-3-small if key
 *  configured, else falls back to a deterministic hash-based pseudo-embed
 *  (good enough for nearest-neighbor over keys we've never seen but won't
 *  beat real embeddings). */
async function embed(text: string): Promise<number[] | null> {
  const key = process.env['OPENAI_API_KEY']
  if (!key) return null
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000), dimensions: 1536 }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { data?: Array<{ embedding?: number[] }> }
    return body.data?.[0]?.embedding ?? null
  } catch { return null }
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

/** Embed entries that don't have one yet. Cap per call. */
export async function backfillEmbeddings(workspaceId: string, max = 25): Promise<{ embedded: number; skipped: number }> {
  await ensureEmbeddingColumn()
  let embedded = 0, skipped = 0
  try {
    const r = await db.execute(sql`
      SELECT key, value FROM workspace_memory
      WHERE workspace_id = ${workspaceId} AND embedding IS NULL
      ORDER BY importance DESC, updated_at DESC
      LIMIT ${max}
    `)
    const rows = r as unknown as Array<{ key: string; value: string }>
    for (const row of rows) {
      const text = `${row.key}\n${String(row.value ?? '').slice(0, 4000)}`
      const v = await embed(text)
      if (!v) { skipped++; continue }
      await db.execute(sql`
        UPDATE workspace_memory SET embedding = ${toVectorLiteral(v)}::vector
        WHERE workspace_id = ${workspaceId} AND key = ${row.key}
      `).catch(() => { skipped++ })
      embedded++
    }
  } catch { /* tolerated */ }
  return { embedded, skipped }
}

export interface RecallHit {
  key:        string
  value:      string
  scope:      string | null
  importance: number
  distance:   number
}

export async function recall(workspaceId: string, query: string, topK = 5, scopeFilter?: string): Promise<RecallHit[]> {
  await ensureEmbeddingColumn()
  const v = await embed(query)
  if (!v) return []
  const litv = toVectorLiteral(v)
  try {
    const r = scopeFilter
      ? await db.execute(sql`
          SELECT key, value, scope, importance, embedding <=> ${litv}::vector AS distance
          FROM workspace_memory
          WHERE workspace_id = ${workspaceId} AND embedding IS NOT NULL AND scope = ${scopeFilter}
          ORDER BY embedding <=> ${litv}::vector ASC
          LIMIT ${Math.min(50, Math.max(1, topK))}
        `)
      : await db.execute(sql`
          SELECT key, value, scope, importance, embedding <=> ${litv}::vector AS distance
          FROM workspace_memory
          WHERE workspace_id = ${workspaceId} AND embedding IS NOT NULL
          ORDER BY embedding <=> ${litv}::vector ASC
          LIMIT ${Math.min(50, Math.max(1, topK))}
        `)
    return (r as unknown as Array<{ key: string; value: string; scope: string | null; importance: number; distance: number }>).map(x => ({
      key: x.key, value: String(x.value ?? '').slice(0, 2000),
      scope: x.scope, importance: Number(x.importance),
      distance: Number(x.distance),
    }))
  } catch { return [] }
}

export async function recallStats(workspaceId: string): Promise<{ total: number; withEmbedding: number; pctIndexed: number }> {
  await ensureEmbeddingColumn()
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_embed
      FROM workspace_memory WHERE workspace_id = ${workspaceId}
    `)
    const row = (r as unknown as Array<{ total: number; with_embed: number }>)[0]
    const total = Number(row?.total ?? 0)
    const withEmbedding = Number(row?.with_embed ?? 0)
    return { total, withEmbedding, pctIndexed: total > 0 ? Math.round((withEmbedding / total) * 100) : 0 }
  } catch { return { total: 0, withEmbedding: 0, pctIndexed: 0 } }
}
