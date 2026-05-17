/**
 * web-fetch.ts — Safe outbound fetch for "learning from the internet".
 *
 * Guards:
 *   1. URL allowlist check — only http/https public schemes; no file://, no
 *      private IP ranges (RFC 1918) unless explicitly allowed.
 *   2. Size cap — ~200kb max response body; oversize truncated.
 *   3. Secret redaction — body passes through secret-redactor before persist.
 *   4. Timeout — 10s default.
 *   5. Cache-first — if URL was fetched recently and TTL hasn't expired,
 *      returns the cached row instead of hitting the network.
 *
 * Every fetch is persisted to `external_knowledge` table and emits a
 * `web_fetch.completed` event. Failures emit `web_fetch.failed`.
 */
import { db }              from '../db/client.js'
import { externalKnowledge, events } from '../db/schema.js'
import { eq, and, desc }   from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'
import { redactSecrets, hasRawSecrets } from './secret-redactor.js'

export const FETCH_TIMEOUT_MS = 10_000
export const MAX_BODY_BYTES   = 200_000
export const DEFAULT_TTL_MS   = 24 * 60 * 60_000  // 1 day

export type FetchSource = 'manual' | 'cron-rss' | 'llm-research'

export interface WebFetchInput {
  url:          string
  workspaceId:  string
  source?:      FetchSource
  fetchedBy?:   string
  tags?:        string[]
  ttlMs?:       number
  forceRefresh?: boolean
}

export interface WebFetchResult {
  id:              string
  url:             string
  status:          number
  contentType:     string | null
  contentRedacted: string
  contentBytes:    number
  secretsRedacted: number
  title:           string | null
  fromCache:       boolean
  error?:          string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'web-fetch', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

/** Reject private IP ranges, file://, javascript:, data:, etc. */
function urlIsSafe(rawUrl: string): { ok: boolean; reason?: string } {
  let u: URL
  try { u = new URL(rawUrl) } catch { return { ok: false, reason: 'Invalid URL' } }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Disallowed protocol: ${u.protocol}` }
  }

  // Block private + link-local + loopback addresses (best-effort string match)
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') {
    return { ok: false, reason: 'Localhost not allowed' }
  }
  if (/^10\./.test(host)) return { ok: false, reason: 'Private 10/8 not allowed' }
  if (/^192\.168\./.test(host)) return { ok: false, reason: 'Private 192.168/16 not allowed' }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok: false, reason: 'Private 172.16/12 not allowed' }
  if (/^169\.254\./.test(host)) return { ok: false, reason: 'Link-local 169.254/16 not allowed' }
  if (host.endsWith('.local')) return { ok: false, reason: 'mDNS .local not allowed' }

  return { ok: true }
}

/** Crude HTML title extraction without a parser dep. */
function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)
  return m && m[1] ? m[1].trim() : null
}

// ─── Cache lookup ────────────────────────────────────────────────────────────

async function findFreshCache(workspaceId: string, url: string): Promise<typeof externalKnowledge.$inferSelect | null> {
  const rows = await db.select().from(externalKnowledge)
    .where(and(
      eq(externalKnowledge.workspaceId, workspaceId),
      eq(externalKnowledge.url, url),
    ))
    .orderBy(desc(externalKnowledge.fetchedAt))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  if (row.expiresAt && row.expiresAt < Date.now()) return null
  return row
}

// ─── Main fetch ──────────────────────────────────────────────────────────────

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const safety = urlIsSafe(input.url)
  if (!safety.ok) {
    await emitEvent(input.workspaceId, 'web_fetch.blocked', { url: input.url, reason: safety.reason })
    throw new Error(`URL rejected: ${safety.reason}`)
  }

  // Cache-first
  if (!input.forceRefresh) {
    const cached = await findFreshCache(input.workspaceId, input.url)
    if (cached) {
      return {
        id: cached.id, url: cached.url, status: cached.status,
        contentType: cached.contentType, contentRedacted: cached.contentRedacted,
        contentBytes: cached.contentBytes, secretsRedacted: cached.secretsRedacted,
        title: cached.title, fromCache: true,
      }
    }
  }

  // Live fetch with timeout
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  let status   = 0
  let contentType: string | null = null
  let rawBody  = ''

  try {
    const r = await fetch(input.url, {
      method:  'GET',
      signal:  ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Novan-Research/0.1 (+novan)' },
    })
    status = r.status
    contentType = r.headers.get('content-type')

    // Stream + truncate to MAX_BODY_BYTES
    const reader = r.body?.getReader()
    if (reader) {
      const chunks: Uint8Array[] = []
      let total = 0
      while (total < MAX_BODY_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
        if (total >= MAX_BODY_BYTES) { await reader.cancel().catch(() => null); break }
      }
      const buf = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, MAX_BODY_BYTES - off)), off); off += c.length }
      rawBody = new TextDecoder('utf-8').decode(buf.subarray(0, Math.min(off, MAX_BODY_BYTES)))
    } else {
      rawBody = (await r.text()).slice(0, MAX_BODY_BYTES)
    }
  } catch (e) {
    clearTimeout(timer)
    await emitEvent(input.workspaceId, 'web_fetch.failed', {
      url: input.url, error: (e as Error).message,
    })
    throw new Error(`Fetch failed: ${(e as Error).message}`)
  }
  clearTimeout(timer)

  // Redact secrets defensively (in case a leaked credential appears in body)
  const redacted = redactSecrets(rawBody)
  const title    = (contentType?.includes('html') ? extractTitle(rawBody) : null)

  // Persist
  const now = Date.now()
  const id  = uuidv7()
  await db.insert(externalKnowledge).values({
    id,
    workspaceId:     input.workspaceId,
    url:             input.url,
    source:          input.source ?? 'manual',
    fetchedAt:       now,
    status,
    contentType,
    contentRedacted: redacted.redacted,
    contentBytes:    rawBody.length,
    secretsRedacted: redacted.count,
    title,
    tags:            input.tags ?? [],
    expiresAt:       now + (input.ttlMs ?? DEFAULT_TTL_MS),
    fetchedBy:       input.fetchedBy ?? null,
    createdAt:       now,
  })

  await emitEvent(input.workspaceId, 'web_fetch.completed', {
    id, url: input.url, status, bytes: rawBody.length,
    secretsRedacted: redacted.count, source: input.source ?? 'manual',
  })

  return {
    id, url: input.url, status, contentType,
    contentRedacted: redacted.redacted, contentBytes: rawBody.length,
    secretsRedacted: redacted.count, title, fromCache: false,
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export async function listExternalKnowledge(
  workspaceId: string, limit = 50,
): Promise<Array<typeof externalKnowledge.$inferSelect>> {
  return db.select().from(externalKnowledge)
    .where(eq(externalKnowledge.workspaceId, workspaceId))
    .orderBy(desc(externalKnowledge.fetchedAt))
    .limit(limit)
}

export async function getExternalKnowledge(id: string) {
  const rows = await db.select().from(externalKnowledge)
    .where(eq(externalKnowledge.id, id)).limit(1)
  return rows[0] ?? null
}

/** Diagnostic — confirm a fetched row has no leaked credentials. */
export function verifyRedacted(content: string): { clean: boolean; patterns: string[] } {
  return hasRawSecrets(content)
}
