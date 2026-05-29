/**
 * asset-cache.ts — content-hash dedup + persistent index for scraped assets.
 *
 * The scraper currently re-downloads the same Pexels clip every time a
 * query happens to match. This module:
 *   1. Hashes downloaded bytes (sha256) — exact-content dedup
 *   2. Indexes by (query, source) → cached path for fast lookup
 *   3. Survives restarts via a JSON index in CACHE_DIR
 *
 * `getOrFetch(key, fetchFn)` is the main entry: returns cached path if
 * hit, otherwise calls fetchFn and caches the result.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CACHE_DIR = process.env['ASSET_CACHE_DIR'] ?? join(tmpdir(), 'novan-asset-cache')
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
const INDEX_PATH = join(CACHE_DIR, 'index.json')

interface IndexEntry { key: string; path: string; size: number; hash: string; ts: number; meta?: Record<string, unknown> }
interface Index { entries: Record<string, IndexEntry>; bySize: Record<number, string[]> }

let _index: Index | null = null
async function loadIndex(): Promise<Index> {
  if (_index) return _index
  if (existsSync(INDEX_PATH)) {
    try { _index = JSON.parse(await readFile(INDEX_PATH, 'utf8')) as Index } catch { /* */ }
  }
  if (!_index) _index = { entries: {}, bySize: {} }
  return _index
}
async function saveIndex(): Promise<void> {
  if (!_index) return
  await writeFile(INDEX_PATH, JSON.stringify(_index), 'utf8')
}

async function hashFile(path: string): Promise<string> {
  // Stream-hash so we don't block the event loop on multi-GB videos.
  const { createReadStream } = await import('node:fs')
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (c: Buffer | string) => h.update(c))
    s.on('end',  () => resolve(h.digest('hex')))
    s.on('error', reject)
  })
}

export interface CacheKey { query: string; source: string; ext: string; extra?: string }
function keyOf(k: CacheKey): string {
  return `${k.source}|${k.query.toLowerCase()}|${k.ext}|${k.extra ?? ''}`
}

/** Lookup-only. Returns cached path or null. */
export async function lookup(key: CacheKey): Promise<string | null> {
  const idx = await loadIndex()
  const e = idx.entries[keyOf(key)]
  if (!e) return null
  if (!existsSync(e.path)) {
    delete idx.entries[keyOf(key)]
    await saveIndex()
    return null
  }
  return e.path
}

/**
 * Hash-dedupe: if the same content already exists under any other key,
 * link/copy to the new key but don't re-store the bytes.
 */
export async function ingest(key: CacheKey, tmpPath: string, meta?: Record<string, unknown>): Promise<string> {
  if (!existsSync(tmpPath)) throw new Error('asset-cache.ingest: tmpPath missing')
  const idx = await loadIndex()
  const size = statSync(tmpPath).size
  // Fast path: size-bucket → hash compare
  const candidates = idx.bySize[size] ?? []
  let hash: string | null = null
  for (const candKey of candidates) {
    const cand = idx.entries[candKey]
    if (!cand || !existsSync(cand.path)) continue
    if (!hash) hash = await hashFile(tmpPath)
    if (hash === cand.hash) {
      idx.entries[keyOf(key)] = { ...cand, key: keyOf(key) }
      if (meta) idx.entries[keyOf(key)]!.meta = meta
      await saveIndex()
      return cand.path
    }
  }
  if (!hash) hash = await hashFile(tmpPath)
  // Sanitize ext so a malicious key like `mp4|../escape` can't break
  // out of CACHE_DIR or smuggle shell metacharacters into ffmpeg later.
  // Keep only [A-Za-z0-9] (typical extensions: mp4, jpg, png, webp, mp3).
  const ext = key.ext.replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'bin'
  const finalPath = join(CACHE_DIR, `${hash.slice(0, 16)}.${ext}`)
  if (!existsSync(finalPath)) await copyFile(tmpPath, finalPath)
  const entry: IndexEntry = { key: keyOf(key), path: finalPath, size, hash, ts: Date.now() }
  if (meta) entry.meta = meta
  idx.entries[keyOf(key)] = entry
  if (!idx.bySize[size]) idx.bySize[size] = []
  idx.bySize[size]!.push(keyOf(key))
  await saveIndex()
  return finalPath
}

export async function getOrFetch(key: CacheKey, fetcher: () => Promise<string | null>, meta?: Record<string, unknown>): Promise<string | null> {
  const hit = await lookup(key)
  if (hit) return hit
  const tmp = await fetcher()
  if (!tmp) return null
  return ingest(key, tmp, meta)
}

export async function stats(): Promise<{ entries: number; totalBytes: number; uniqueHashes: number }> {
  const idx = await loadIndex()
  const entries = Object.values(idx.entries)
  const uniqueHashes = new Set(entries.map(e => e.hash)).size
  let totalBytes = 0
  for (const h of new Set(entries.map(e => e.hash))) {
    const e = entries.find(x => x.hash === h)
    if (e) totalBytes += e.size
  }
  return { entries: entries.length, totalBytes, uniqueHashes }
}

export async function clear(): Promise<{ removed: number }> {
  const idx = await loadIndex()
  const n = Object.keys(idx.entries).length
  _index = { entries: {}, bySize: {} }
  await saveIndex()
  return { removed: n }
}
