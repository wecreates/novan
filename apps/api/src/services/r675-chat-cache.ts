/**
 * R675 — In-memory chat response cache.
 *
 * Hashes (workspaceId + systemPrompt + userMessage + toolList) → assistant
 * reply with a short TTL. Identical questions returned instantly with zero
 * model spend. Only caches when no tools were called (tool results vary
 * over time so caching would mask reality).
 */
import crypto from 'crypto'

const TTL_MS = 10 * 60_000  // 10 min
const MAX_ENTRIES = 500

interface Entry { answer: string; tokens: number; costUsd: number; expiresAt: number }

const cache = new Map<string, Entry>()
const stats = { hits: 0, misses: 0 }

function keyFor(workspaceId: string, system: string, message: string, tools: string[]): string {
  const body = `${workspaceId}|${system}|${message}|${[...tools].sort().join(',')}`
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)
}

function gc(): void {
  if (cache.size <= MAX_ENTRIES) return
  const drop = Math.ceil(MAX_ENTRIES * 0.2)
  const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, drop)
  for (const [k] of entries) cache.delete(k)
}

export function getCached(workspaceId: string, system: string, message: string, tools: string[]): Entry | null {
  const k = keyFor(workspaceId, system, message, tools)
  const hit = cache.get(k)
  if (hit && hit.expiresAt > Date.now()) { stats.hits++; return hit }
  stats.misses++
  return null
}

export function setCached(workspaceId: string, system: string, message: string, tools: string[], answer: string, tokens: number, costUsd: number): void {
  const k = keyFor(workspaceId, system, message, tools)
  cache.set(k, { answer, tokens, costUsd, expiresAt: Date.now() + TTL_MS })
  gc()
}

export function getChatCacheStats(): { hits: number; misses: number; size: number; hitRate: number } {
  const total = stats.hits + stats.misses
  return { ...stats, size: cache.size, hitRate: total === 0 ? 0 : Number((stats.hits / total).toFixed(3)) }
}

export function clearChatCache(): { cleared: number } {
  const n = cache.size
  cache.clear()
  return { cleared: n }
}
