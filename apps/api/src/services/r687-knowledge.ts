/**
 * R687 — RAG knowledge base end-to-end.
 *
 * `knowledge.ingest_url`: fetch URL → strip to readable text → chunk → embed
 *                         (R685) → store in r687_kb_chunks with workspace tag.
 * `knowledge.ingest_text`: same pipeline starting from raw text.
 * `knowledge.query`: embed the query → cosine-search the chunks → return
 *                    top-k snippets with source URLs.
 * `knowledge.list/.delete`: manage stored documents.
 *
 * Chunks are ~800 chars with 80-char overlap. Good middle ground between
 * recall and per-token cost.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'
import { embedText } from './r685-embeddings.js'

const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 80
const MAX_CHUNKS_PER_DOC = 200

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r687_kb_docs (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        source_url    TEXT,
        title         TEXT,
        chunks        INT NOT NULL DEFAULT 0,
        tokens        INT NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r687_kb_chunks (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        doc_id       TEXT NOT NULL,
        seq          INT NOT NULL,
        text         TEXT NOT NULL,
        embedding    vector(1536),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r687_chunks_vec_idx ON r687_kb_chunks USING hnsw (embedding vector_cosine_ops)`).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r687_chunks_doc_idx ON r687_kb_chunks (workspace_id, doc_id)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

function vecLiteral(v: number[]): string { return '[' + v.join(',') + ']' }

function chunkText(text: string): string[] {
  const out: string[] = []
  const norm = text.replace(/\s+/g, ' ').trim()
  if (!norm) return out
  let i = 0
  while (i < norm.length && out.length < MAX_CHUNKS_PER_DOC) {
    out.push(norm.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return out
}

function htmlToText(html: string): string {
  // Pre-strip script/style. Then remove tags, decode common entities.
  const noScripts = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const noTags = noScripts.replace(/<[^>]+>/g, ' ')
  return noTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim()
}

function titleOf(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m?.[1]?.trim()
}

export interface IngestUrlInput { url: string; title?: string }
export interface IngestTextInput { text: string; title?: string; sourceUrl?: string }

export async function ingestUrl(workspaceId: string, input: IngestUrlInput): Promise<{ ok: boolean; docId?: string; chunks?: number; tokens?: number; error?: string }> {
  await ensureDdl()
  if (!input.url) return { ok: false, error: 'url required' }
  try {
    const res = await fetch(input.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 Novan-R687', 'Accept': 'text/html,application/xhtml+xml,text/plain' },
    })
    if (!res.ok) return { ok: false, error: `fetch ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    const raw = await res.text()
    const text = ct.includes('html') ? htmlToText(raw) : raw
    const title = input.title ?? titleOf(raw) ?? input.url
    return ingestText(workspaceId, { text, title, sourceUrl: input.url })
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function ingestText(workspaceId: string, input: IngestTextInput): Promise<{ ok: boolean; docId?: string; chunks?: number; tokens?: number; error?: string }> {
  await ensureDdl()
  if (!input.text?.trim()) return { ok: false, error: 'text required' }
  const chunks = chunkText(input.text)
  if (chunks.length === 0) return { ok: false, error: 'no chunks produced' }

  const docId = `kb_${crypto.randomBytes(8).toString('hex')}`
  let totalTokens = 0
  let inserted = 0

  // Embed + insert each chunk
  for (let i = 0; i < chunks.length; i++) {
    const emb = await embedText(chunks[i]!)
    if (!emb.ok || !emb.vector) continue
    totalTokens += emb.tokens ?? 0
    const chunkId = `kc_${crypto.randomBytes(6).toString('hex')}`
    const lit = vecLiteral(emb.vector)
    try {
      await db.execute(sql.raw(`INSERT INTO r687_kb_chunks (id, workspace_id, doc_id, seq, text, embedding) VALUES ('${chunkId}', '${workspaceId.replace(/'/g, "''")}', '${docId}', ${i}, $$${chunks[i]!.replace(/\$/g, '\\$')}$$, '${lit}'::vector)`))
      inserted++
    } catch { /* tolerated */ }
  }
  try {
    await db.execute(sql`
      INSERT INTO r687_kb_docs (id, workspace_id, source_url, title, chunks, tokens)
      VALUES (${docId}, ${workspaceId}, ${input.sourceUrl ?? null}, ${input.title ?? null}, ${inserted}, ${totalTokens})
    `)
  } catch { /* tolerated */ }
  return { ok: true, docId, chunks: inserted, tokens: totalTokens }
}

export interface QueryInput { queryText: string; limit?: number; minSimilarity?: number }
export interface QueryHit { chunkId: string; docId: string; sourceUrl: string | null; title: string | null; text: string; similarity: number }

export async function queryKb(workspaceId: string, input: QueryInput): Promise<{ ok: boolean; hits?: QueryHit[]; error?: string }> {
  await ensureDdl()
  if (!input.queryText) return { ok: false, error: 'queryText required' }
  const emb = await embedText(input.queryText)
  if (!emb.ok || !emb.vector) return { ok: false, error: emb.error ?? 'embed failed' }
  const limit = Math.max(1, Math.min(20, input.limit ?? 5))
  const minSim = input.minSimilarity ?? 0
  try {
    const lit = vecLiteral(emb.vector)
    const rows = await db.execute(sql`
      SELECT c.id AS chunk_id, c.doc_id, c.text, d.source_url, d.title,
             1 - (c.embedding <=> ${lit}::vector) AS similarity
      FROM r687_kb_chunks c
      JOIN r687_kb_docs d ON d.id = c.doc_id
      WHERE c.workspace_id = ${workspaceId} AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${lit}::vector
      LIMIT ${limit}
    `)
    const hits = ((rows.rows ?? rows) as Array<Record<string, unknown>>)
      .map(r => ({
        chunkId: String(r['chunk_id']),
        docId: String(r['doc_id']),
        sourceUrl: r['source_url'] ? String(r['source_url']) : null,
        title: r['title'] ? String(r['title']) : null,
        text: String(r['text']),
        similarity: Number(r['similarity']),
      }))
      .filter(h => h.similarity >= minSim)
    return { ok: true, hits }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function listKbDocs(workspaceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, source_url, title, chunks, tokens, created_at
      FROM r687_kb_docs WHERE workspace_id = ${workspaceId}
      ORDER BY created_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function deleteKbDoc(workspaceId: string, docId: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`DELETE FROM r687_kb_chunks WHERE doc_id = ${docId} AND workspace_id = ${workspaceId}`)
    await db.execute(sql`DELETE FROM r687_kb_docs   WHERE id     = ${docId} AND workspace_id = ${workspaceId}`)
    return { ok: true }
  } catch { return { ok: false } }
}
