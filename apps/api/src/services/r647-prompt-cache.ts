/**
 * R647c — Prompt-caching auto-mark.
 *
 * Tracks system-prompt prefixes by SHA-256. When the same prefix is observed
 * ≥2 times, OR exceeds a length threshold, it's marked as cache-eligible.
 *
 * Anthropic: cache_control: { type: 'ephemeral' } is added to the system block.
 * OpenAI: cache prefix is automatic above ~1024 tokens; we just track stats.
 * Gemini: cachedContent is server-side; we just track stats.
 *
 * The provider adapters can call shouldCache(text) to decide whether to attach
 * the marker. This module also persists hit/miss telemetry to power the spend
 * sparkline + an /ops/cache panel.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const MIN_LENGTH_FOR_CACHE = 4000   // ~1000+ tokens — Anthropic minimum
const MIN_HITS_FOR_AUTO    = 2      // see same prefix 2× → mark

interface CacheStats {
  hash:        string
  length:      number
  hits:        number
  saved_usd:   number
  last_seen:   Date
  first_seen:  Date
  marked:      boolean
}

const memoryStats = new Map<string, CacheStats>()
let ddlOk = false

async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r647_prompt_cache (
        hash         TEXT PRIMARY KEY,
        length       INT NOT NULL,
        hits         INT NOT NULL DEFAULT 0,
        saved_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
        marked       BOOLEAN NOT NULL DEFAULT false,
        first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    ddlOk = true
  } catch { /* tolerated */ }
}

function hash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** Called by the chat router/provider before each request. */
export async function shouldCache(systemPromptText: string, opts?: { provider?: string }): Promise<{
  cache: boolean
  hash: string
  reason: string
}> {
  await ensureDdl()
  const h = hash(systemPromptText)
  const length = systemPromptText.length

  // Auto-mark based on length alone (single long shared prompt is worth caching)
  if (length >= MIN_LENGTH_FOR_CACHE) {
    await recordObservation(h, length, true)
    return { cache: true, hash: h, reason: `length=${length}` }
  }

  // Otherwise, mark after N observations
  const stats = await observe(h, length)
  if (stats.hits >= MIN_HITS_FOR_AUTO) {
    return { cache: true, hash: h, reason: `seen ${stats.hits}× (provider=${opts?.provider ?? 'any'})` }
  }
  return { cache: false, hash: h, reason: `seen ${stats.hits}× (below threshold ${MIN_HITS_FOR_AUTO})` }
}

async function observe(h: string, length: number): Promise<CacheStats> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      INSERT INTO r647_prompt_cache (hash, length, hits, last_seen)
      VALUES (${h}, ${length}, 1, now())
      ON CONFLICT (hash) DO UPDATE
      SET hits = r647_prompt_cache.hits + 1, last_seen = now()
      RETURNING hash, length, hits, saved_usd, marked, first_seen, last_seen
    `)
    const row = (rows.rows ?? rows)[0] as Record<string, unknown>
    const stats: CacheStats = {
      hash:       String(row['hash']),
      length:     Number(row['length']),
      hits:       Number(row['hits']),
      saved_usd:  Number(row['saved_usd'] ?? 0),
      marked:     row['marked'] === true,
      first_seen: new Date(String(row['first_seen'])),
      last_seen:  new Date(String(row['last_seen'])),
    }
    memoryStats.set(h, stats)
    return stats
  } catch {
    const existing = memoryStats.get(h)
    const stats: CacheStats = existing
      ? { ...existing, hits: existing.hits + 1, last_seen: new Date() }
      : { hash: h, length, hits: 1, saved_usd: 0, marked: false, first_seen: new Date(), last_seen: new Date() }
    memoryStats.set(h, stats)
    return stats
  }
}

async function recordObservation(h: string, length: number, marked: boolean): Promise<void> {
  await ensureDdl()
  try {
    await db.execute(sql`
      INSERT INTO r647_prompt_cache (hash, length, hits, marked, last_seen)
      VALUES (${h}, ${length}, 1, ${marked}, now())
      ON CONFLICT (hash) DO UPDATE
      SET hits = r647_prompt_cache.hits + 1, marked = ${marked}, last_seen = now()
    `)
  } catch { /* tolerated */ }
}

/** Called by provider adapter when a response confirms a cache hit. */
export async function recordCacheHit(systemPromptHash: string, savedUsd: number): Promise<void> {
  await ensureDdl()
  try {
    await db.execute(sql`
      UPDATE r647_prompt_cache
      SET saved_usd = saved_usd + ${savedUsd}
      WHERE hash = ${systemPromptHash}
    `)
  } catch { /* tolerated */ }
}

export async function listCacheStats(limit = 50): Promise<CacheStats[]> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT hash, length, hits, saved_usd, marked, first_seen, last_seen
      FROM r647_prompt_cache
      ORDER BY hits DESC, length DESC
      LIMIT ${limit}
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      hash: String(r['hash']),
      length: Number(r['length']),
      hits: Number(r['hits']),
      saved_usd: Number(r['saved_usd'] ?? 0),
      marked: r['marked'] === true,
      first_seen: new Date(String(r['first_seen'])),
      last_seen: new Date(String(r['last_seen'])),
    }))
  } catch {
    return [...memoryStats.values()].sort((a, b) => b.hits - a.hits).slice(0, limit)
  }
}

export async function renderCacheHtml(): Promise<string> {
  const stats = await listCacheStats(100)
  const totalSaved = stats.reduce((s, r) => s + r.saved_usd, 0)
  const totalHits = stats.reduce((s, r) => s + r.hits, 0)
  const rows = stats.map(s => `
    <tr>
      <td><code>${s.hash.slice(0, 12)}…</code></td>
      <td>${s.length}</td>
      <td>${s.hits}</td>
      <td>${s.marked ? '✓' : ''}</td>
      <td>$${s.saved_usd.toFixed(4)}</td>
      <td>${s.first_seen.toISOString().slice(0, 16)}</td>
    </tr>`).join('')
  return `<!doctype html><html><head><title>R647 prompt cache</title>
    <style>body{font:14px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}
    table{width:100%;border-collapse:collapse}th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left}
    th{background:#f7f7f7}.s{font:13px monospace;color:#555}</style></head>
    <body><h1>R647 prompt-cache marker</h1>
    <p class="s">total prefixes: ${stats.length} · total hits: ${totalHits} · estimated saved: $${totalSaved.toFixed(4)}</p>
    <!-- R647c -->
    <table><thead><tr><th>hash</th><th>len</th><th>hits</th><th>marked</th><th>saved</th><th>first seen</th></tr></thead>
    <tbody>${rows}</tbody></table></body></html>`
}
