/**
 * R657 — Free web.search via DuckDuckGo HTML SERP.
 *
 * R618 research.deep already does a heavy DDG scrape + LLM synthesis. R657
 * exposes the raw search step as its own brain op so the agent loop can do
 * cheap lookups ("what's the current price of X", "who's the CEO of Y")
 * without paying for an LLM synthesis pass.
 *
 * No API key. Honors a per-process rate limit so concurrent agent loops
 * don't get the droplet blocked.
 */

interface RawResult { title: string; url: string; snippet: string }

const MAX_RESULTS = 10
const TIMEOUT_MS  = 8000

const lastFire: { ts: number } = { ts: 0 }
const MIN_INTERVAL_MS = 800

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, '').trim() }

function unwrapDDGUrl(href: string): string {
  // DDG wraps real URLs in /l/?kh=-1&uddg=<encoded>
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m?.[1]) try { return decodeURIComponent(m[1]) } catch { /* fall through */ }
  if (href.startsWith('//')) return 'https:' + href
  return href
}

export interface SearchInput {
  query:   string
  limit?:  number
  region?: string
}

export interface SearchResult {
  ok:      boolean
  query:   string
  results: RawResult[]
  error?:  string
  latencyMs: number
}

export async function webSearch(input: SearchInput): Promise<SearchResult> {
  const t0 = Date.now()
  if (!input.query?.trim()) return { ok: false, query: input.query ?? '', results: [], error: 'query required', latencyMs: 0 }
  const limit = Math.max(1, Math.min(MAX_RESULTS, input.limit ?? 5))

  // Rudimentary rate limit
  const since = Date.now() - lastFire.ts
  if (since < MIN_INTERVAL_MS) await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - since))
  lastFire.ts = Date.now()

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}${input.region ? `&kl=${encodeURIComponent(input.region)}` : ''}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Novan/R657',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, query: input.query, results: [], error: `ddg ${res.status}`, latencyMs: Date.now() - t0 }
    const html = await res.text()

    const results: RawResult[] = []
    // Match each result block: title link + snippet
    const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(html)) !== null && results.length < limit) {
      const href = m[1] ?? ''
      const titleRaw = m[2] ?? ''
      const snippetRaw = m[3] ?? ''
      const realUrl = unwrapDDGUrl(href)
      const title   = decodeEntities(stripTags(titleRaw))
      const snippet = decodeEntities(stripTags(snippetRaw))
      if (title && realUrl) results.push({ title, url: realUrl, snippet })
    }
    return { ok: true, query: input.query, results, latencyMs: Date.now() - t0 }
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, query: input.query, results: [], error: (e as Error).message, latencyMs: Date.now() - t0 }
  }
}
