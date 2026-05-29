/**
 * search-providers.ts — Real web search abstraction.
 *
 * Adapters for Tavily, Serper, Brave. Selected by SEARCH_PROVIDER env var.
 * Each adapter returns a normalized SearchHit[] array.
 *
 * No fakes: if SEARCH_API_KEY/SEARCH_PROVIDER missing → empty result + reason.
 *
 * All providers route through `fetchWithRetry` so 429/5xx/network blips don't
 * collapse a research request — exponential backoff + per-provider circuit
 * breaker prevents thrashing during incidents.
 */
import { fetchWithRetry } from './provider-retry.js'
export interface SearchHit {
  url:     string
  title:   string
  snippet: string
  rank:    number
}

export interface SearchResult {
  query:    string
  provider: string | null
  hits:     SearchHit[]
  error?:   string
}

async function tavily(query: string, key: string, max: number): Promise<SearchHit[]> {
  const out = await fetchWithRetry('search:tavily', 'https://api.tavily.com/search', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key:        key,
      query,
      max_results:    max,
      search_depth:   'basic',
      include_answer: false,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!out.ok) throw new Error(`Tavily ${out.status}: ${out.statusText}`)
  const res = out.response
  const body = await res.json().catch((e: unknown) => {
    console.error('[search-providers] JSON parse failed on Tavily 2xx response:', (e as Error).message)
    return {}
  }) as Record<string, unknown>
  const results = (body['results'] as Array<{ url?: string; title?: string; content?: string }> | undefined) ?? []
  return results.slice(0, max).map((r, i) => ({
    url:     String(r.url ?? ''),
    title:   String(r.title ?? ''),
    snippet: String(r.content ?? '').slice(0, 400),
    rank:    i + 1,
  })).filter(h => h.url.startsWith('http'))
}

async function serper(query: string, key: string, max: number): Promise<SearchHit[]> {
  const out = await fetchWithRetry('search:serper', 'https://google.serper.dev/search', {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': key },
    body:    JSON.stringify({ q: query, num: max }),
    signal:  AbortSignal.timeout(15_000),
  })
  if (!out.ok) throw new Error(`Serper ${out.status}: ${out.statusText}`)
  const res = out.response
  const body = await res.json().catch((e: unknown) => {
    console.error('[search-providers] JSON parse failed on Serper 2xx response:', (e as Error).message)
    return {}
  }) as Record<string, unknown>
  const results = (body['organic'] as Array<{ link?: string; title?: string; snippet?: string }> | undefined) ?? []
  return results.slice(0, max).map((r, i) => ({
    url:     String(r.link ?? ''),
    title:   String(r.title ?? ''),
    snippet: String(r.snippet ?? '').slice(0, 400),
    rank:    i + 1,
  })).filter(h => h.url.startsWith('http'))
}

async function brave(query: string, key: string, max: number): Promise<SearchHit[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`
  const out = await fetchWithRetry('search:brave', url, {
    headers: { 'X-Subscription-Token': key, 'accept': 'application/json' },
    signal:  AbortSignal.timeout(15_000),
  })
  if (!out.ok) throw new Error(`Brave ${out.status}: ${out.statusText}`)
  const res = out.response
  const body = await res.json().catch((e: unknown) => {
    console.error('[search-providers] JSON parse failed on Brave 2xx response:', (e as Error).message)
    return {}
  }) as Record<string, unknown>
  const web = body['web'] as { results?: Array<{ url?: string; title?: string; description?: string }> } | undefined
  const results = web?.results ?? []
  return results.slice(0, max).map((r, i) => ({
    url:     String(r.url ?? ''),
    title:   String(r.title ?? ''),
    snippet: String(r.description ?? '').slice(0, 400),
    rank:    i + 1,
  })).filter(h => h.url.startsWith('http'))
}

export async function webSearch(query: string, opts?: { max?: number }): Promise<SearchResult> {
  const max = Math.min(opts?.max ?? 5, 10)
  const provider = process.env['SEARCH_PROVIDER']?.toLowerCase()
  const key      = process.env['SEARCH_API_KEY']
  if (!provider || !key) {
    return { query, provider: null, hits: [], error: 'SEARCH_PROVIDER / SEARCH_API_KEY not configured' }
  }
  try {
    let hits: SearchHit[] = []
    if (provider === 'tavily')      hits = await tavily(query, key, max)
    else if (provider === 'serper') hits = await serper(query, key, max)
    else if (provider === 'brave')  hits = await brave(query, key, max)
    else return { query, provider, hits: [], error: `unsupported provider: ${provider}` }
    return { query, provider, hits }
  } catch (e) {
    return { query, provider, hits: [], error: (e as Error).message }
  }
}
