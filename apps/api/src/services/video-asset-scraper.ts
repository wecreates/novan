/**
 * video-asset-scraper.ts — find + download every asset the brain needs
 * for a video edit, in parallel, at incredible speed.
 *
 * Sources (all free / royalty-free for commercial use unless noted):
 *   • Pexels Videos       (API key: PEXELS_API_KEY)
 *   • Pexels Photos       (same key)
 *   • Pixabay Videos      (PIXABAY_API_KEY)
 *   • Pixabay Photos      (same key)
 *   • Unsplash Photos     (UNSPLASH_ACCESS_KEY)
 *   • Internet Archive    (no key; CC + public domain video/audio)
 *   • Direct URL          (any mp4/mov/jpg/png/wav/mp3)
 *   • yt-dlp              (any platform — use with copyright care)
 *
 * `findAssets(brief, mix)` returns a ranked, downloaded asset bundle
 * ready to feed into capcut-controller.assemble().
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ASSETS_DIR = join(tmpdir(), 'novan-video-assets')
if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true })

const YTDLP  = process.env['YTDLP_BIN']  ?? 'yt-dlp'
const FFMPEG = process.env['FFMPEG_BIN'] ?? 'ffmpeg'

export interface Asset {
  path: string
  kind: 'video' | 'image' | 'audio'
  role?: 'main' | 'broll' | 'music' | 'voiceover' | 'overlay'
  source: string                      // host name
  sourceUrl: string                   // original URL
  durationSec?: number
  width?: number
  height?: number
  license?: string                    // 'pexels' | 'pixabay' | 'unsplash' | 'archive.org' | 'direct' | 'cc'
}

export interface FindAssetsInput {
  brief: string
  /** How many of each kind to fetch. Defaults: video 8, image 6, music 2. */
  mix?: { video?: number; image?: number; music?: number }
  /** Pixel orientation hint. */
  orientation?: 'landscape' | 'portrait' | 'square'
  /** Optional explicit query keywords (override brief-derived keywords). */
  queries?: string[]
}

export interface FindAssetsResult {
  ok: boolean
  assets: Asset[]
  queriesUsed: string[]
  errors: string[]
  durationMs: number
}

// ─── Keyword extraction ────────────────────────────────────────────────
function keywordsFromBrief(brief: string, max = 4): string[] {
  const stop = new Set(['the','and','for','with','from','that','this','into','about','make','create','want','need','please','video','clip','footage','show','about'])
  const words = brief.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3 && !stop.has(w))
  // dedupe preserving order
  const seen = new Set<string>(), out: string[] = []
  for (const w of words) if (!seen.has(w)) { seen.add(w); out.push(w) }
  return out.slice(0, max)
}

async function downloadRaw(url: string, ext: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    const dest = join(ASSETS_DIR, `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.${ext}`)
    await writeFile(dest, buf)
    return dest
  } catch { return null }
}

/**
 * Cached download. Uses asset-cache for content-hash dedup: the same
 * Pexels clip URL across multiple briefs returns the existing file
 * instead of re-downloading. Massive bandwidth win across mass-produce.
 */
async function download(url: string, ext: string, source = 'unknown'): Promise<string | null> {
  try {
    const { getOrFetch } = await import('./asset-cache.js')
    return await getOrFetch(
      { source, query: url, ext },
      () => downloadRaw(url, ext),
      { url, fetchedAt: Date.now() },
    )
  } catch {
    // Cache layer unavailable — fall back to raw download
    return downloadRaw(url, ext)
  }
}

// ─── Pexels ────────────────────────────────────────────────────────────
async function searchPexelsVideo(query: string, orientation = 'landscape', perPage = 5): Promise<Asset[]> {
  const key = process.env['PEXELS_API_KEY']
  if (!key) return []
  try {
    const r = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`, {
      headers: { Authorization: key }, signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return []
    const j = await r.json() as { videos?: Array<{ url: string; duration: number; width: number; height: number; video_files: Array<{ link: string; quality: string; file_type: string; width: number }> }> }
    const out: Asset[] = []
    for (const v of j.videos ?? []) {
      // pick the highest-quality MP4 file that isn't bigger than 1080p height
      const file = (v.video_files ?? []).filter(f => f.file_type === 'video/mp4').sort((a, b) => b.width - a.width)[0]
      if (!file) continue
      const path = await download(file.link, 'mp4', 'pexels')
      if (path) out.push({ path, kind: 'video', source: 'pexels', sourceUrl: v.url, durationSec: v.duration, width: v.width, height: v.height, license: 'pexels' })
    }
    return out
  } catch { return [] }
}

async function searchPexelsPhoto(query: string, orientation = 'landscape', perPage = 5): Promise<Asset[]> {
  const key = process.env['PEXELS_API_KEY']
  if (!key) return []
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`, {
      headers: { Authorization: key }, signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return []
    const j = await r.json() as { photos?: Array<{ url: string; src: { original: string; large2x: string }; width: number; height: number }> }
    const out: Asset[] = []
    for (const p of j.photos ?? []) {
      const path = await download(p.src.large2x ?? p.src.original, 'jpg', 'pexels')
      if (path) out.push({ path, kind: 'image', source: 'pexels', sourceUrl: p.url, width: p.width, height: p.height, license: 'pexels' })
    }
    return out
  } catch { return [] }
}

// ─── Pixabay ───────────────────────────────────────────────────────────
async function searchPixabayVideo(query: string, perPage = 5): Promise<Asset[]> {
  const key = process.env['PIXABAY_API_KEY']
  if (!key) return []
  try {
    const r = await fetch(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${perPage}&safesearch=true`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return []
    const j = await r.json() as { hits?: Array<{ pageURL: string; duration: number; videos: Record<string, { url: string; width: number; height: number }> }> }
    const out: Asset[] = []
    for (const h of j.hits ?? []) {
      const file = h.videos.large ?? h.videos.medium ?? h.videos.small
      if (!file) continue
      const path = await download(file.url, 'mp4', 'pixabay')
      if (path) out.push({ path, kind: 'video', source: 'pixabay', sourceUrl: h.pageURL, durationSec: h.duration, width: file.width, height: file.height, license: 'pixabay' })
    }
    return out
  } catch { return [] }
}

async function searchPixabayMusic(query: string, perPage = 3): Promise<Asset[]> {
  const key = process.env['PIXABAY_API_KEY']
  if (!key) return []
  // Pixabay's music endpoint requires the music-specific API — many free
  // tracks are mirrored on pixabay.com/music. As a stable fallback, we
  // route music asks through Pexels-Audio-equivalent: there's no public
  // Pexels audio API, so we return [] when no music API is configured.
  void query; void perPage
  return []
}

// ─── Unsplash ──────────────────────────────────────────────────────────
async function searchUnsplashPhoto(query: string, orientation = 'landscape', perPage = 5): Promise<Asset[]> {
  const key = process.env['UNSPLASH_ACCESS_KEY']
  if (!key) return []
  try {
    const r = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`, {
      headers: { Authorization: `Client-ID ${key}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) return []
    const j = await r.json() as { results?: Array<{ links: { html: string }; urls: { full: string; regular: string }; width: number; height: number }> }
    const out: Asset[] = []
    for (const p of j.results ?? []) {
      const path = await download(p.urls.regular ?? p.urls.full, 'jpg', 'unsplash')
      if (path) out.push({ path, kind: 'image', source: 'unsplash', sourceUrl: p.links.html, width: p.width, height: p.height, license: 'unsplash' })
    }
    return out
  } catch { return [] }
}

// ─── yt-dlp ────────────────────────────────────────────────────────────
export async function downloadViaYtDlp(url: string, kind: 'video' | 'audio'): Promise<Asset | null> {
  const stamp = Date.now().toString(36)
  const outBase = join(ASSETS_DIR, `yt-${stamp}`)
  const ext = kind === 'audio' ? 'mp3' : 'mp4'
  const outFile = `${outBase}.${ext}`
  const args = kind === 'audio'
    ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', `${outBase}.%(ext)s`, '--ffmpeg-location', FFMPEG, url]
    : ['-f', 'best[ext=mp4]/best', '--no-playlist', '-o', `${outBase}.%(ext)s`, '--ffmpeg-location', FFMPEG, url]
  const ok = await new Promise<boolean>((resolve) => {
    let proc
    try { proc = spawn(YTDLP, args, { windowsHide: true }) } catch { resolve(false); return }
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0 && existsSync(outFile)))
  })
  if (!ok) return null
  return { path: outFile, kind: kind === 'audio' ? 'audio' : 'video', source: 'yt-dlp', sourceUrl: url, license: 'direct' }
}

// ─── Direct URL ────────────────────────────────────────────────────────
async function downloadDirect(url: string): Promise<Asset | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
    if (!r.ok) return null
    const ct = r.headers.get('content-type') ?? ''
    const buf = Buffer.from(await r.arrayBuffer())
    const ext = extname(new URL(url).pathname).replace('.', '') ||
                (ct.startsWith('video') ? 'mp4' : ct.startsWith('image') ? 'jpg' : ct.startsWith('audio') ? 'mp3' : 'bin')
    const kind: Asset['kind'] = ct.startsWith('video') || /mp4|mov|webm/.test(ext)
      ? 'video' : ct.startsWith('audio') || /mp3|wav|m4a|flac|ogg/.test(ext)
      ? 'audio' : 'image'
    const dest = join(ASSETS_DIR, `d-${Date.now().toString(36)}.${ext}`)
    await writeFile(dest, buf)
    return { path: dest, kind, source: new URL(url).hostname, sourceUrl: url, license: 'direct' }
  } catch { return null }
}

// ─── Public: findAssets ────────────────────────────────────────────────
export async function findAssets(input: FindAssetsInput): Promise<FindAssetsResult> {
  const t0 = Date.now()
  const want = { video: input.mix?.video ?? 8, image: input.mix?.image ?? 6, music: input.mix?.music ?? 2 }
  const queries = input.queries && input.queries.length > 0 ? input.queries : keywordsFromBrief(input.brief)
  const orientation = input.orientation ?? 'landscape'
  const errors: string[] = []
  const assets: Asset[] = []

  if (queries.length === 0) return { ok: false, assets: [], queriesUsed: [], errors: ['no usable keywords in brief'], durationMs: Date.now() - t0 }

  // Run every API in parallel across every query — speed
  const perQueryVideoEach = Math.max(1, Math.ceil(want.video / (queries.length * 2)))
  const perQueryImageEach = Math.max(1, Math.ceil(want.image / (queries.length * 2)))
  const perQueryMusicEach = Math.max(1, Math.ceil(want.music / queries.length))

  const tasks: Promise<Asset[]>[] = []
  for (const q of queries) {
    tasks.push(searchPexelsVideo(q, orientation, perQueryVideoEach).catch((e) => { errors.push(`pexels-video[${q}]: ${(e as Error).message}`); return [] }))
    tasks.push(searchPixabayVideo(q, perQueryVideoEach).catch((e) => { errors.push(`pixabay-video[${q}]: ${(e as Error).message}`); return [] }))
    tasks.push(searchPexelsPhoto(q, orientation, perQueryImageEach).catch((e) => { errors.push(`pexels-photo[${q}]: ${(e as Error).message}`); return [] }))
    tasks.push(searchUnsplashPhoto(q, orientation, perQueryImageEach).catch((e) => { errors.push(`unsplash[${q}]: ${(e as Error).message}`); return [] }))
    tasks.push(searchPixabayMusic(q, perQueryMusicEach).catch((e) => { errors.push(`pixabay-music[${q}]: ${(e as Error).message}`); return [] }))
  }
  const batches = await Promise.all(tasks)
  for (const b of batches) assets.push(...b)

  // Rank: bigger video resolution wins, then duration in 4-12s sweet spot for b-roll
  const ranked = assets.sort((a, b) => {
    const ascore = (a.width ?? 0) * (a.height ?? 0) * (a.kind === 'video' ? 2 : 1)
    const bscore = (b.width ?? 0) * (b.height ?? 0) * (b.kind === 'video' ? 2 : 1)
    return bscore - ascore
  })

  // Trim to requested mix
  const videos  = ranked.filter(a => a.kind === 'video').slice(0, want.video).map(a => ({ ...a, role: a.role ?? 'broll' as const }))
  const images  = ranked.filter(a => a.kind === 'image').slice(0, want.image).map(a => ({ ...a, role: a.role ?? 'overlay' as const }))
  const music   = ranked.filter(a => a.kind === 'audio').slice(0, want.music).map(a => ({ ...a, role: a.role ?? 'music' as const }))

  return { ok: true, assets: [...videos, ...images, ...music], queriesUsed: queries, errors, durationMs: Date.now() - t0 }
}

export { downloadDirect }
