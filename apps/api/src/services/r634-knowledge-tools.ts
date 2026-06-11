/**
 * R634 — Knowledge tools: URL-tree crawler (E2), memory editor write-side (E3), auto-tagging (E5).
 *
 *   rag.ingest_site   — crawl a docs site (same-origin only), N depth, ingest each page
 *                       as a RAG document via R621.ingest.
 *   memory.upsert     — write/update a workspace_memory entry by key
 *   memory.delete     — remove a workspace_memory entry by key
 *   knowledge.auto_tag — given text, LLM proposes 3-8 topical tags
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import type { ChatMsg } from './chat-providers.js'

// ─── E2 URL-tree crawler ────────────────────────────────────────────────────

const MAX_PAGES = 50
const SAME_ORIGIN_ONLY = true

export interface CrawlInput {
  startUrl:     string
  maxDepth?:    number       // default 2, capped at 4
  maxPages?:    number       // default 20, capped at 50
  namePrefix?:  string       // prefix RAG doc names with this
  includePath?: string       // only follow URLs containing this substring
}

export interface CrawlResult {
  pagesIngested: number
  pagesAttempted: number
  failed:        Array<{ url: string; reason: string }>
  docIds:        string[]
}

function extractLinks(html: string, base: string): string[] {
  const links: string[] = []
  for (const m of html.matchAll(/<a[^>]+href="([^"#?][^"#]*)"/gi)) {
    try {
      const u = new URL(m[1] ?? '', base)
      u.hash = ''
      u.search = ''
      links.push(u.toString())
    } catch { /* malformed href */ }
  }
  return [...new Set(links)]
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function ingestSite(workspaceId: string, input: CrawlInput): Promise<CrawlResult> {
  if (!input.startUrl?.trim()) throw new Error('startUrl required')
  let startOrigin: string
  try { startOrigin = new URL(input.startUrl).origin } catch { throw new Error('startUrl invalid') }

  const maxDepth = Math.max(0, Math.min(4, input.maxDepth ?? 2))
  const maxPages = Math.max(1, Math.min(MAX_PAGES, input.maxPages ?? 20))
  const prefix = input.namePrefix ?? new URL(input.startUrl).hostname

  const visited = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = [{ url: input.startUrl, depth: 0 }]
  const failed: CrawlResult['failed'] = []
  const docIds: string[] = []

  const { ingest } = await import('./r621-document-rag.js')

  while (queue.length > 0 && visited.size < maxPages) {
    const item = queue.shift()
    if (!item) break
    if (visited.has(item.url)) continue
    visited.add(item.url)
    if (SAME_ORIGIN_ONLY) {
      try { if (new URL(item.url).origin !== startOrigin) continue } catch { continue }
    }
    if (input.includePath && !item.url.includes(input.includePath)) continue
    try {
      const r = await fetch(item.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 Novan-Crawler/1.0' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!r.ok) { failed.push({ url: item.url, reason: `http ${r.status}` }); continue }
      const html = await r.text()
      const text = htmlToText(html)
      if (text.length > 200) {
        const titleM = html.match(/<title>([^<]+)<\/title>/i)
        const name = `${prefix}: ${(titleM?.[1] ?? new URL(item.url).pathname).slice(0, 100)}`
        const ing = await ingest(workspaceId, { name, text, mime: 'text/html' })
        docIds.push(ing.docId)
      }
      if (item.depth < maxDepth) {
        const links = extractLinks(html, item.url)
        for (const l of links.slice(0, 30)) {
          if (!visited.has(l)) queue.push({ url: l, depth: item.depth + 1 })
        }
      }
    } catch (e) {
      failed.push({ url: item.url, reason: (e as Error).message })
    }
  }

  return { pagesIngested: docIds.length, pagesAttempted: visited.size, failed, docIds }
}

// ─── E3 Memory editor write-side ────────────────────────────────────────────

export interface MemoryUpsertInput {
  key:        string
  value:      string
  scope?:     string         // 'global' default
  importance?: number        // 0-100
}

export async function memoryUpsert(workspaceId: string, input: MemoryUpsertInput): Promise<{ ok: boolean }> {
  if (!input.key?.trim()) throw new Error('key required')
  if (typeof input.value !== 'string') throw new Error('value required (string)')
  const scope = input.scope ?? 'global'
  const importance = typeof input.importance === 'number' ? Math.max(0, Math.min(100, input.importance)) : 50
  await db.execute(sql`
    INSERT INTO workspace_memory (workspace_id, key, value, scope, importance, updated_at)
    VALUES (${workspaceId}, ${input.key}, ${input.value}, ${scope}, ${importance}, ${Date.now()})
    ON CONFLICT (workspace_id, key) DO UPDATE SET
      value = EXCLUDED.value, scope = EXCLUDED.scope,
      importance = EXCLUDED.importance, updated_at = EXCLUDED.updated_at
  `).catch(() => {})
  return { ok: true }
}

export async function memoryDelete(workspaceId: string, key: string): Promise<{ ok: boolean; deleted: number }> {
  if (!key?.trim()) throw new Error('key required')
  const r = await db.execute(sql`DELETE FROM workspace_memory WHERE workspace_id = ${workspaceId} AND key = ${key} RETURNING key`).catch(() => [] as unknown[])
  return { ok: true, deleted: (r as unknown[]).length }
}

export async function memoryList(workspaceId: string, opts: { scope?: string; limit?: number } = {}): Promise<Array<{ key: string; value: string; scope: string; importance: number; updatedAt: number }>> {
  const lim = Math.max(1, Math.min(500, opts.limit ?? 100))
  const r = opts.scope
    ? await db.execute(sql`SELECT key, value, scope, importance, updated_at FROM workspace_memory WHERE workspace_id = ${workspaceId} AND scope = ${opts.scope} ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT key, value, scope, importance, updated_at FROM workspace_memory WHERE workspace_id = ${workspaceId} ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    key:        String(row['key']),
    value:      String(row['value']),
    scope:      String(row['scope']),
    importance: Number(row['importance'] ?? 50),
    updatedAt:  Number(row['updated_at'] ?? 0),
  }))
}

// ─── E5 Auto-tagging ────────────────────────────────────────────────────────

export interface AutoTagInput {
  text:    string
  maxTags?: number
}

export interface AutoTagResult {
  tags:   string[]
  topic:  string
  tokens: number
  costUsd: number
}

export async function autoTag(workspaceId: string, input: AutoTagInput): Promise<AutoTagResult> {
  if (!input.text?.trim()) throw new Error('text required')
  const maxTags = Math.max(3, Math.min(15, input.maxTags ?? 6))
  const msgs: ChatMsg[] = [
    { role: 'system', content: `You assign topical tags. Output JSON: { "topic": string (≤5 words), "tags": string[] (${maxTags} lowercase, hyphenated). Tags should be specific (e.g. "post-quantum-crypto" not "security"). No stopwords.` },
    { role: 'user', content: input.text.slice(0, 12000) },
  ]
  const { streamChat } = await import('./chat-providers.js')
  let raw = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: false })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) raw += next.value.delta
  final = next.value
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('LLM did not return JSON')
  let parsed: { topic?: string; tags?: string[] }
  try { parsed = JSON.parse(m[0]) } catch { throw new Error('tag JSON parse failed') }
  const tags = (parsed.tags ?? []).map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')).filter(t => t.length >= 2).slice(0, maxTags)
  return { tags, topic: parsed.topic ?? '', tokens: final.tokens, costUsd: final.costUsd }
}
