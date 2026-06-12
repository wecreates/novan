/**
 * R665 — In-memory tool result cache.
 *
 * Many agent runs re-issue the same tool call within seconds
 * ("web.search 'X'" called from PLAN then again from ACT, or two
 * sub-agents both pulling github.repo). R665 wraps tool execution
 * with a hash → result cache keyed on (op, params) with a short
 * TTL. Saves cost + latency on repetitive workflows without
 * masking actual state changes (TTL kept conservative at 60s).
 *
 * Only safe-to-cache reads are eligible — write/effectful ops
 * (sms.send, desktop.act, image.openai.generate) are excluded.
 */
import crypto from 'crypto'

const TTL_MS = 60_000
const MAX_ENTRIES = 1000

const CACHEABLE = new Set([
  'web.search', 'web.fetch', 'scrape.extract',
  'github.repo', 'github.release', 'github.readme',
  'brain.list', 'memory.list', 'memory.recall',
  'rag.query', 'kg.search', 'kg.mermaid',
  'research.youtube_transcript', 'research.arxiv',
])

interface Entry { value: unknown; expiresAt: number }
const cache = new Map<string, Entry>()
const stats = { hits: 0, misses: 0, skipped: 0 }

function keyFor(op: string, workspaceId: string, params: Record<string, unknown>): string {
  let body: string
  try { body = JSON.stringify(params, Object.keys(params).sort()) } catch { body = String(params) }
  return crypto.createHash('sha256').update(`${op}|${workspaceId}|${body}`).digest('hex').slice(0, 32)
}

function gcIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return
  // Drop oldest 20%
  const drop = Math.ceil(MAX_ENTRIES * 0.2)
  const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, drop)
  for (const [k] of entries) cache.delete(k)
}

/**
 * If the op is cacheable + we have a fresh hit, return it.
 * Else run the loader, cache the result (if cacheable + ok), and return.
 */
export async function withToolCache<T>(
  op: string,
  workspaceId: string,
  params: Record<string, unknown>,
  loader: () => Promise<T>,
): Promise<{ value: T; cacheHit: boolean }> {
  if (!CACHEABLE.has(op)) {
    stats.skipped++
    return { value: await loader(), cacheHit: false }
  }
  const k = keyFor(op, workspaceId, params)
  const now = Date.now()
  const hit = cache.get(k)
  if (hit && hit.expiresAt > now) {
    stats.hits++
    return { value: hit.value as T, cacheHit: true }
  }
  stats.misses++
  const value = await loader()
  cache.set(k, { value, expiresAt: now + TTL_MS })
  gcIfNeeded()
  return { value, cacheHit: false }
}

export function getCacheStats(): { hits: number; misses: number; skipped: number; size: number; hitRate: number } {
  const total = stats.hits + stats.misses
  return {
    ...stats,
    size: cache.size,
    hitRate: total === 0 ? 0 : Number((stats.hits / total).toFixed(3)),
  }
}

export function clearToolCache(): { cleared: number } {
  const n = cache.size
  cache.clear()
  return { cleared: n }
}
