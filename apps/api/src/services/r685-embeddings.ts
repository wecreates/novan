/**
 * R685 — OpenAI embeddings + semantic recall.
 *
 * Replaces R653's keyword-overlap with vector similarity. Two tables get
 * an embedding column (r649_agent_runs.goal_vec, r663_chat_turns.message_vec)
 * plus an HNSW index. New backfill + query helpers, plus a brain op
 * `embed.text` for ad-hoc use (RAG ingest, dedupe).
 *
 * Model: text-embedding-3-small, 1536 dims, $0.02/1M tokens (~free).
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const DIM = 1536
const MODEL = 'text-embedding-3-small'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {})
    await db.execute(sql`ALTER TABLE r649_agent_runs ADD COLUMN IF NOT EXISTS goal_vec vector(1536)`).catch(() => {})
    await db.execute(sql`ALTER TABLE r663_chat_turns ADD COLUMN IF NOT EXISTS message_vec vector(1536)`).catch(() => {})
    // HNSW indexes for fast cosine search
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r649_goal_vec_idx ON r649_agent_runs USING hnsw (goal_vec vector_cosine_ops)`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r663_message_vec_idx ON r663_chat_turns USING hnsw (message_vec vector_cosine_ops)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export async function embedText(text: string): Promise<{ ok: boolean; vector?: number[]; tokens?: number; error?: string }> {
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) return { ok: false, error: 'OPENAI_API_KEY not set' }
  if (!text?.trim()) return { ok: false, error: 'text required' }
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8000), dimensions: DIM }),
    })
    if (!res.ok) return { ok: false, error: `openai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
    const j = await res.json() as { data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number } }
    const vec = j.data?.[0]?.embedding
    if (!Array.isArray(vec)) return { ok: false, error: 'no embedding in response' }
    return { ok: true, vector: vec, tokens: j.usage?.prompt_tokens ?? 0 }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

/** pgvector wants the literal "[0.1,0.2,…]" form on input. */
function vecLiteral(v: number[]): string { return '[' + v.join(',') + ']' }

export interface SemanticHit { id: string; goal?: string; user_message?: string; assistant_msg?: string; similarity: number; created_at: string }

export async function findSimilarRunsByVector(workspaceId: string, queryText: string, limit = 5): Promise<SemanticHit[]> {
  await ensureDdl()
  const emb = await embedText(queryText)
  if (!emb.ok || !emb.vector) return []
  try {
    const lit = vecLiteral(emb.vector)
    const rows = await db.execute(sql`
      SELECT id, goal, status, answer, created_at,
             1 - (goal_vec <=> ${lit}::vector) AS similarity
      FROM r649_agent_runs
      WHERE workspace_id = ${workspaceId} AND status IN ('done', 'capped') AND goal_vec IS NOT NULL
      ORDER BY goal_vec <=> ${lit}::vector
      LIMIT ${limit}
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      id: String(r['id']),
      goal: String(r['goal'] ?? ''),
      assistant_msg: String(r['answer'] ?? ''),
      similarity: Number(r['similarity'] ?? 0),
      created_at: String(r['created_at']),
    }))
  } catch { return [] }
}

export async function findSimilarChatTurns(workspaceId: string, queryText: string, limit = 5): Promise<SemanticHit[]> {
  await ensureDdl()
  const emb = await embedText(queryText)
  if (!emb.ok || !emb.vector) return []
  try {
    const lit = vecLiteral(emb.vector)
    const rows = await db.execute(sql`
      SELECT id, user_message, assistant_msg, created_at,
             1 - (message_vec <=> ${lit}::vector) AS similarity
      FROM r663_chat_turns
      WHERE workspace_id = ${workspaceId} AND message_vec IS NOT NULL
      ORDER BY message_vec <=> ${lit}::vector
      LIMIT ${limit}
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      id: String(r['id']),
      user_message: String(r['user_message'] ?? ''),
      assistant_msg: String(r['assistant_msg'] ?? ''),
      similarity: Number(r['similarity'] ?? 0),
      created_at: String(r['created_at']),
    }))
  } catch { return [] }
}

/** Cron-callable backfill — embeds rows that are missing their vector. */
export async function backfillEmbeddings(workspaceId: string, table: 'agent' | 'chat', limit = 50): Promise<{ ok: boolean; embedded: number; errors: number; tokens: number }> {
  await ensureDdl()
  let rows: Array<Record<string, unknown>> = []
  try {
    if (table === 'agent') {
      const r = await db.execute(sql`SELECT id, goal FROM r649_agent_runs WHERE workspace_id = ${workspaceId} AND goal_vec IS NULL AND goal IS NOT NULL LIMIT ${limit}`)
      rows = (r.rows ?? r) as Array<Record<string, unknown>>
    } else {
      const r = await db.execute(sql`SELECT id, user_message FROM r663_chat_turns WHERE workspace_id = ${workspaceId} AND message_vec IS NULL AND user_message IS NOT NULL LIMIT ${limit}`)
      rows = (r.rows ?? r) as Array<Record<string, unknown>>
    }
  } catch { return { ok: false, embedded: 0, errors: 0, tokens: 0 } }

  let embedded = 0, errors = 0, tokens = 0
  for (const row of rows) {
    const text = table === 'agent' ? String(row['goal'] ?? '') : String(row['user_message'] ?? '')
    if (!text.trim()) continue
    const emb = await embedText(text)
    if (!emb.ok || !emb.vector) { errors++; continue }
    tokens += emb.tokens ?? 0
    try {
      const lit = vecLiteral(emb.vector)
      if (table === 'agent') {
        await db.execute(sql`UPDATE r649_agent_runs SET goal_vec = ${lit}::vector WHERE id = ${String(row['id'])}`)
      } else {
        await db.execute(sql`UPDATE r663_chat_turns SET message_vec = ${lit}::vector WHERE id = ${String(row['id'])}`)
      }
      embedded++
    } catch { errors++ }
  }
  return { ok: true, embedded, errors, tokens }
}
