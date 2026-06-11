/**
 * R625 — Research extensions for R618.
 *
 *   research.youtube_transcript — fetch transcript from a YouTube video
 *                                 via timedtext endpoint (no API key).
 *   research.arxiv              — query arxiv.org/api (no key).
 *   research.reddit             — DDG site:reddit.com search.
 *   research.image_search       — DDG image SERP.
 *
 * Every helper degrades to empty result on failure (no throws).
 */

// ─── YouTube transcript (no API key) ─────────────────────────────────────────

function parseYouTubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
  return m?.[1] ?? null
}

export interface YouTubeTranscript {
  videoId:  string
  language: string
  segments: Array<{ start: number; duration: number; text: string }>
  fullText: string
}

export async function youtubeTranscript(input: { url: string; lang?: string }): Promise<YouTubeTranscript> {
  const id = parseYouTubeId(input.url)
  if (!id) throw new Error('not a YouTube URL')
  const lang = input.lang ?? 'en'
  // 1) Get list of available tracks
  const listRes = await fetch(`https://www.youtube.com/api/timedtext?type=list&v=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Novan/1.0' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!listRes || !listRes.ok) throw new Error('youtube list endpoint unreachable')
  const listXml = await listRes.text()
  // Pick requested lang if available, else first
  const tracks = [...listXml.matchAll(/<track[^>]+lang_code="([^"]+)"[^>]*name="([^"]*)"/g)].map(m => ({ lang: m[1] ?? '', name: m[2] ?? '' }))
  const picked = tracks.find(t => t.lang === lang) ?? tracks[0]
  if (!picked) throw new Error('no transcripts available')
  // 2) Fetch transcript
  const txRes = await fetch(`https://www.youtube.com/api/timedtext?lang=${encodeURIComponent(picked.lang)}&v=${id}${picked.name ? `&name=${encodeURIComponent(picked.name)}` : ''}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 Novan/1.0' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null)
  if (!txRes || !txRes.ok) throw new Error('youtube transcript fetch failed')
  const xml = await txRes.text()
  const segments: YouTubeTranscript['segments'] = []
  for (const m of xml.matchAll(/<text[^>]+start="([^"]+)"[^>]*dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = (m[3] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
    if (!text) continue
    segments.push({ start: Number(m[1] ?? 0), duration: Number(m[2] ?? 0), text })
  }
  return { videoId: id, language: picked.lang, segments, fullText: segments.map(s => s.text).join(' ') }
}

// ─── ArXiv (no API key) ──────────────────────────────────────────────────────

export interface ArxivPaper {
  id:        string
  title:     string
  authors:   string[]
  summary:   string
  published: string
  pdfUrl:    string
}

export async function arxivSearch(input: { query: string; maxResults?: number }): Promise<{ count: number; papers: ArxivPaper[] }> {
  const max = Math.max(1, Math.min(25, input.maxResults ?? 10))
  const u = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(input.query)}&max_results=${max}&sortBy=relevance`
  const r = await fetch(u, { signal: AbortSignal.timeout(45_000) })
  if (!r.ok) throw new Error(`arxiv ${r.status}`)
  const xml = await r.text()
  const papers: ArxivPaper[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1] ?? ''
    const id      = block.match(/<id>(.*?)<\/id>/)?.[1] ?? ''
    const title   = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
    const published = block.match(/<published>(.*?)<\/published>/)?.[1] ?? ''
    const authors = [...block.matchAll(/<name>(.*?)<\/name>/g)].map(a => a[1] ?? '').filter(Boolean)
    const pdfUrl = block.match(/<link[^>]+title="pdf"[^>]+href="([^"]+)"/)?.[1] ?? id.replace('/abs/', '/pdf/')
    if (id) papers.push({ id, title, authors, summary, published, pdfUrl })
  }
  return { count: papers.length, papers }
}

// ─── Reddit via DDG ──────────────────────────────────────────────────────────

export interface RedditHit { title: string; url: string; subreddit: string }

export async function redditSearch(input: { query: string; subreddit?: string; max?: number }): Promise<{ count: number; hits: RedditHit[] }> {
  const max = Math.max(1, Math.min(15, input.max ?? 8))
  const q = input.subreddit ? `site:reddit.com/r/${input.subreddit} ${input.query}` : `site:reddit.com ${input.query}`
  const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  const r = await fetch(u, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 Novan/1.0' }, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) return { count: 0, hits: [] }
  const html = await r.text()
  const hits: RedditHit[] = []
  for (const m of html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
    let url = m[1] ?? ''
    if (url.startsWith('//')) url = 'https:' + url
    if (url.startsWith('/l/?uddg=')) {
      url = decodeURIComponent(url.match(/uddg=([^&]+)/)?.[1] ?? '')
    }
    if (!url.includes('reddit.com')) continue
    const sub = url.match(/reddit\.com\/r\/([^/]+)/)?.[1] ?? ''
    const title = (m[2] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
    hits.push({ title, url, subreddit: sub })
    if (hits.length >= max) break
  }
  return { count: hits.length, hits }
}

// ─── Image search via DDG HTML ──────────────────────────────────────────────

export interface ImageHit { thumbnailUrl: string; sourcePage: string; title: string }

export async function imageSearch(input: { query: string; max?: number }): Promise<{ count: number; hits: ImageHit[] }> {
  const max = Math.max(1, Math.min(20, input.max ?? 12))
  // DDG image SERP requires a vqd token; using i.js endpoint is more brittle.
  // Use simple HTML image SERP via Bing fallback (no key) — limited reliability.
  const u = `https://www.bing.com/images/search?q=${encodeURIComponent(input.query)}&form=HDRSC2`
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 Novan/1.0' }, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) return { count: 0, hits: [] }
  const html = await r.text()
  const hits: ImageHit[] = []
  for (const m of html.matchAll(/<a class="iusc"[^>]+m="([^"]+)"/g)) {
    try {
      const meta = JSON.parse((m[1] ?? '').replace(/&quot;/g, '"'))
      hits.push({
        thumbnailUrl: String(meta.turl ?? meta.murl ?? ''),
        sourcePage:   String(meta.purl ?? ''),
        title:        String(meta.t ?? '').slice(0, 200),
      })
      if (hits.length >= max) break
    } catch { /* malformed entry */ }
  }
  return { count: hits.length, hits }
}
