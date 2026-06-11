/**
 * R621 — Document RAG (NotebookLM-class).
 *
 * Drop text/markdown documents, chunk + embed + store, then ask
 * grounded questions with [N] citations to the source chunks.
 *
 * First pass: text + markdown only (no PDF — that needs pdfjs-dist).
 * PDF arrives in R622 once we add the dep.
 *
 * Schema:
 *   rag_documents      (id, ws, name, mime, bytes, chunks_count, created_at)
 *   rag_chunks         (id, doc_id, ws, chunk_index, text, embedding vector(N))
 *
 * Embedding provider chosen by existing embeddings.embed() — automatically
 * routes via Ollama / OpenAI / Gemini / HF depending on env.
 *
 * Cosine retrieval done in-process for now (k≤500 chunks fits easily).
 * Migration to pgvector ANN index when corpus crosses 50k chunks.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

const CHUNK_SIZE = 1200       // chars per chunk (≈300 tokens)
const CHUNK_OVERLAP = 150     // chars overlap between chunks

export interface RagDocument {
  id:          string
  workspaceId: string
  name:        string
  mime:        string
  bytes:       number
  chunksCount: number
  createdAt:   number
}

export interface RagChunk {
  id:         string
  docId:      string
  chunkIndex: number
  text:       string
  hasEmbedding: boolean
}

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rag_documents (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      mime          TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      chunks_count  INTEGER NOT NULL DEFAULT 0,
      created_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id            TEXT PRIMARY KEY,
      doc_id        TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      chunk_index   INTEGER NOT NULL,
      text          TEXT NOT NULL,
      embedding     JSONB,
      created_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS rag_chunks_ws_doc_idx ON rag_chunks (workspace_id, doc_id, chunk_index)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS rag_docs_ws_idx ON rag_documents (workspace_id, created_at DESC)`).catch(() => {})
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function chunk(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (cleaned.length === 0) return []
  if (cleaned.length <= CHUNK_SIZE) return [cleaned]
  const out: string[] = []
  let i = 0
  while (i < cleaned.length) {
    let end = Math.min(i + CHUNK_SIZE, cleaned.length)
    if (end < cleaned.length) {
      // backtrack to nearest paragraph/sentence boundary
      const para = cleaned.lastIndexOf('\n\n', end)
      const sent = cleaned.lastIndexOf('. ', end)
      const cut = Math.max(para, sent, i + CHUNK_SIZE / 2)
      if (cut > i + 100) end = cut + 2
    }
    out.push(cleaned.slice(i, end).trim())
    if (end >= cleaned.length) break
    i = end - CHUNK_OVERLAP
  }
  return out
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestInput {
  name:  string
  text:  string
  mime?: string
}

export interface IngestResult {
  docId:       string
  chunksCount: number
  embedded:    number
  skipped:     number
}

export async function ingest(workspaceId: string, input: IngestInput): Promise<IngestResult> {
  await ensureTables()
  if (!input.name?.trim()) throw new Error('name required')
  if (!input.text?.trim()) throw new Error('text required')
  if (input.text.length > 2_000_000) throw new Error('text too large (>2MB) — split first')

  const docId = uuidv7()
  const chunks = chunk(input.text)
  await db.execute(sql`
    INSERT INTO rag_documents (id, workspace_id, name, mime, bytes, chunks_count, created_at)
    VALUES (${docId}, ${workspaceId}, ${input.name.slice(0, 200)}, ${input.mime ?? 'text/plain'},
            ${input.text.length}, ${chunks.length}, ${Date.now()})
  `)

  const { embed } = await import('./embeddings.js')
  let embedded = 0, skipped = 0
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i] ?? ''
    const id = uuidv7()
    let emb: number[] | null = null
    try { emb = await embed(text) } catch { /* tolerated */ }
    if (emb) embedded++; else skipped++
    await db.execute(sql`
      INSERT INTO rag_chunks (id, doc_id, workspace_id, chunk_index, text, embedding, created_at)
      VALUES (${id}, ${docId}, ${workspaceId}, ${i}, ${text}, ${emb ? sql`${JSON.stringify(emb)}::jsonb` : sql`NULL`}, ${Date.now()})
    `).catch(() => {})
  }
  return { docId, chunksCount: chunks.length, embedded, skipped }
}

// ─── Query ──────────────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? 0, bi = b[i] ?? 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

export interface RagHit {
  citationId: number
  docId:      string
  docName:    string
  chunkIndex: number
  text:       string
  score:      number
}

export interface QueryInput {
  question:    string
  topK?:       number       // default 5
  docId?:      string       // filter to a single document
}

export interface QueryResult {
  question: string
  hits:     RagHit[]
  answer:   string
  latencyMs: number
  tokens:   number
  costUsd:  number
}

export async function query(workspaceId: string, input: QueryInput): Promise<QueryResult> {
  await ensureTables()
  const t0 = Date.now()
  const q = (input.question ?? '').trim()
  if (!q) throw new Error('question required')
  const topK = Math.max(1, Math.min(20, input.topK ?? 5))

  const { embed } = await import('./embeddings.js')
  const qEmb = await embed(q)
  if (!qEmb) throw new Error('embedding provider unavailable')

  // Pull candidate chunks (embedded only)
  const r = input.docId
    ? await db.execute(sql`SELECT c.id, c.doc_id, c.chunk_index, c.text, c.embedding::text AS embedding_text, d.name AS doc_name FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id WHERE c.workspace_id = ${workspaceId} AND c.doc_id = ${input.docId} AND c.embedding IS NOT NULL`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT c.id, c.doc_id, c.chunk_index, c.text, c.embedding::text AS embedding_text, d.name AS doc_name FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id WHERE c.workspace_id = ${workspaceId} AND c.embedding IS NOT NULL`).catch(() => [] as unknown[])

  const scored: Array<{ docId: string; docName: string; chunkIndex: number; text: string; score: number }> = []
  for (const row of r as Array<Record<string, unknown>>) {
    try {
      const emb = JSON.parse(String(row['embedding_text'] ?? '[]')) as number[]
      if (!Array.isArray(emb) || emb.length === 0) continue
      const score = cosine(qEmb, emb)
      scored.push({
        docId:      String(row['doc_id']),
        docName:    String(row['doc_name']),
        chunkIndex: Number(row['chunk_index']),
        text:       String(row['text']),
        score,
      })
    } catch { /* malformed embedding */ }
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, topK)
  const hits: RagHit[] = top.map((h, i) => ({ citationId: i + 1, docId: h.docId, docName: h.docName, chunkIndex: h.chunkIndex, text: h.text, score: Number(h.score.toFixed(4)) }))

  if (hits.length === 0) {
    return { question: q, hits: [], answer: 'No matching chunks found. Ingest documents first via rag.ingest.', latencyMs: Date.now() - t0, tokens: 0, costUsd: 0 }
  }

  // Synthesize
  const sourcesBlock = hits.map(h => `[${h.citationId}] ${h.docName} (chunk ${h.chunkIndex})\n${h.text}`).join('\n\n')
  const { streamChat } = await import('./chat-providers.js')
  let answer = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, [
    { role: 'system', content: 'You are a document Q&A assistant. Answer using only the provided chunks. Cite as [N] matching the numbered chunks. If the chunks do not contain the answer, say "Not in the provided documents."' },
    { role: 'user', content: `Question: ${q}\n\nChunks:\n${sourcesBlock}\n\nAnswer with [N] citations.` },
  ], { skipUsageTracking: true })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) answer += next.value.delta
  final = next.value

  try {
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId, provider: final.provider, model: final.model,
      promptTokens: 0, outputTokens: final.tokens, costUsd: final.costUsd,
      latencyMs: Date.now() - t0, taskType: 'chat',
    })
  } catch { /* tolerated */ }

  return { question: q, hits, answer: answer.trim(), latencyMs: Date.now() - t0, tokens: final.tokens, costUsd: final.costUsd }
}

// ─── List / delete ──────────────────────────────────────────────────────────

export async function listDocuments(workspaceId: string, limit = 50): Promise<RagDocument[]> {
  await ensureTables()
  const lim = Math.max(1, Math.min(200, limit))
  const r = await db.execute(sql`SELECT * FROM rag_documents WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:          String(row['id']),
    workspaceId: String(row['workspace_id']),
    name:        String(row['name']),
    mime:        String(row['mime']),
    bytes:       Number(row['bytes']),
    chunksCount: Number(row['chunks_count']),
    createdAt:   Number(row['created_at']),
  }))
}

export async function deleteDocument(workspaceId: string, docId: string): Promise<{ ok: boolean; chunksDeleted: number }> {
  await ensureTables()
  const r = await db.execute(sql`DELETE FROM rag_chunks WHERE workspace_id = ${workspaceId} AND doc_id = ${docId} RETURNING id`).catch(() => [] as unknown[])
  await db.execute(sql`DELETE FROM rag_documents WHERE workspace_id = ${workspaceId} AND id = ${docId}`).catch(() => {})
  return { ok: true, chunksDeleted: (r as unknown[]).length }
}

export async function stats(workspaceId: string): Promise<{ documents: number; chunks: number; embeddedChunks: number; totalBytes: number }> {
  await ensureTables()
  const docs = await db.execute(sql`SELECT count(*)::int AS n, COALESCE(sum(bytes),0)::bigint AS b FROM rag_documents WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0, b: 0 }] as unknown[])
  const chunks = await db.execute(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE embedding IS NOT NULL)::int AS e FROM rag_chunks WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0, e: 0 }] as unknown[])
  const d = (docs as Array<Record<string, unknown>>)[0] ?? {}
  const c = (chunks as Array<Record<string, unknown>>)[0] ?? {}
  return {
    documents:      Number(d['n'] ?? 0),
    chunks:         Number(c['n'] ?? 0),
    embeddedChunks: Number(c['e'] ?? 0),
    totalBytes:     Number(d['b'] ?? 0),
  }
}
