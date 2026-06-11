/**
 * R618 — Deep research op (Perplexity-style).
 *
 * Multi-step: decompose question → DDG-search each → fetch top URL per
 * query → synthesize answer with [1][2] citations. Optionally ingest
 * into KG so the answer sticks around.
 *
 * Uses only pieces already in the tree:
 *   - chat-providers.streamChat for LLM calls
 *   - web-fetch.webFetch for grounded data (URL-only)
 *   - r601-knowledge-graph for optional persistence
 *   - inline ddgSearch helper (no API key required)
 *
 * Cost: ~2 LLM calls (decompose + synth) + N fetches + N DDG SERP hits.
 */
import type { ChatMsg } from './chat-providers.js'

export interface ResearchSource {
  citationId: number
  query:      string
  url:        string
  title:      string
  snippet:    string
  fetchedAt:  number
  ok:         boolean
  reason?:    string
}

export interface ResearchResult {
  question:    string
  subQueries:  string[]
  sources:     ResearchSource[]
  answer:      string
  ingestedKgNodeId?: string
  totals: {
    sourcesAttempted: number
    sourcesOk:        number
    latencyMs:        number
    tokens:           number
    costUsd:          number
  }
}

export interface ResearchInput {
  question:       string
  maxQueries?:    number
  ingestToKg?:    boolean
  recency?:       'any' | 'week' | 'month' | 'year'
}

// ─── DDG HTML SERP (no API key) ──────────────────────────────────────────────

async function ddgSearch(query: string): Promise<{ url: string; title: string } | null> {
  try {
    const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Novan-Research/1.0)' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!r.ok) return null
    const html = await r.text()
    // DDG HTML lite uses /l/?uddg=<encoded-url> redirect links. Grab the first.
    const m = html.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/)
    if (!m) return null
    let url = m[1] ?? ''
    if (url.startsWith('//')) url = 'https:' + url
    if (url.startsWith('/l/?uddg=')) {
      const enc = url.match(/uddg=([^&]+)/)?.[1] ?? ''
      url = decodeURIComponent(enc)
    } else if (url.startsWith('/')) {
      url = 'https://duckduckgo.com' + url
    }
    const title = (m[2] ?? query).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().slice(0, 200)
    if (!url.startsWith('http')) return null
    return { url, title }
  } catch { return null }
}

// ─── LLM call wrapper ────────────────────────────────────────────────────────

async function llmCall(workspaceId: string, msgs: ChatMsg[], label: string): Promise<{ text: string; tokens: number; costUsd: number }> {
  const { streamChat } = await import('./chat-providers.js')
  const t0 = Date.now()
  let text = ''
  let final = { tokens: 0, costUsd: 0, provider: 'none', model: 'none' }
  const stream = streamChat(workspaceId, msgs, { skipUsageTracking: true })
  let next: IteratorResult<{ delta: string; done: boolean }, typeof final>
  while (!(next = await stream.next()).done) if (next.value.delta) text += next.value.delta
  final = next.value
  try {
    const { recordAiUsage } = await import('./ai-cost-tracker.js')
    recordAiUsage({
      workspaceId, provider: final.provider, model: final.model,
      promptTokens: 0, outputTokens: final.tokens, costUsd: final.costUsd,
      latencyMs: Date.now() - t0, taskType: 'chat',
    })
  } catch { /* telemetry optional */ }
  return { text: text.trim(), tokens: final.tokens, costUsd: final.costUsd }
}

function parseSubQueries(raw: string, cap: number): string[] {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const out: string[] = []
  for (const l of lines) {
    const cleaned = l.replace(/^[-*•\d.)\s]+/, '').replace(/^["'`]+|["'`]+$/g, '').trim()
    if (cleaned.length > 4 && cleaned.length < 200) out.push(cleaned)
    if (out.length >= cap) break
  }
  return out
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function researchDeep(workspaceId: string, input: ResearchInput): Promise<ResearchResult> {
  const t0 = Date.now()
  const question = (input.question ?? '').trim()
  if (!question) throw new Error('question required')
  const cap = Math.max(2, Math.min(8, input.maxQueries ?? 5))

  // 1) Decompose into search queries
  const recencyHint = input.recency && input.recency !== 'any' ? ` Prefer ${input.recency}-recent sources.` : ''
  const decomp = await llmCall(workspaceId, [
    { role: 'system', content: `You are a research planner. Given a question, output exactly ${cap} distinct, specific web-search queries that together cover the question. One per line, no numbering or preamble.${recencyHint}` },
    { role: 'user', content: question },
  ], 'decompose')
  const subQueries = parseSubQueries(decomp.text, cap)
  if (subQueries.length === 0) throw new Error('decompose returned no queries')

  // 2) DDG search + fetch top result for each, in parallel
  const { webFetch } = await import('./web-fetch.js')
  const fetched = await Promise.all(subQueries.map(async (q, i): Promise<ResearchSource> => {
    const cid = i + 1
    const hit = await ddgSearch(q)
    if (!hit) return { citationId: cid, query: q, url: '', title: q, snippet: '', fetchedAt: Date.now(), ok: false, reason: 'no search results' }
    try {
      const r = await webFetch({ url: hit.url, source: 'llm-research', workspaceId })
      const snippet = String(r.contentRedacted ?? '').slice(0, 400).replace(/\s+/g, ' ').trim()
      return { citationId: cid, query: q, url: hit.url, title: r.title ?? hit.title, snippet, fetchedAt: Date.now(), ok: true }
    } catch (e) {
      return { citationId: cid, query: q, url: hit.url, title: hit.title, snippet: '', fetchedAt: Date.now(), ok: false, reason: (e as Error).message }
    }
  }))

  const okSources = fetched.filter(s => s.ok && s.snippet.length > 20)
  if (okSources.length === 0) {
    return {
      question, subQueries, sources: fetched,
      answer: `No sources could be fetched for: ${question}. DDG returned nothing usable.`,
      totals: { sourcesAttempted: fetched.length, sourcesOk: 0, latencyMs: Date.now() - t0, tokens: decomp.tokens, costUsd: decomp.costUsd },
    }
  }

  // 3) Synthesize with citations
  const sourcesBlock = okSources.map(s => `[${s.citationId}] ${s.title} — ${s.url}\n${s.snippet}`).join('\n\n')
  const synth = await llmCall(workspaceId, [
    { role: 'system', content: 'You are a research synthesizer. Write a concise factual answer in markdown using [N] citations matching the numbered sources. Use only the sources provided; if they do not cover something, say so explicitly. End with a "Sources" section listing each cited [N] with its title and URL.' },
    { role: 'user', content: `Question: ${question}\n\nSources:\n${sourcesBlock}\n\nAnswer with [N] citations.` },
  ], 'synthesize')

  // 4) Optional KG persistence
  let ingestedKgNodeId: string | undefined
  if (input.ingestToKg) {
    try {
      const { upsertNode } = await import('./r601-knowledge-graph.js')
      const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research'
      const r = await upsertNode(workspaceId, {
        name: `research/${slug}`,
        body: `# ${question}\n\n${synth.text}\n\n## Subqueries\n${subQueries.map(q => `- ${q}`).join('\n')}`,
        type: 'note',
        tags: ['research', 'deep'],
      })
      ingestedKgNodeId = r.id
    } catch { /* KG persistence optional */ }
  }

  const result: ResearchResult = {
    question, subQueries, sources: fetched,
    answer: synth.text,
    totals: {
      sourcesAttempted: fetched.length,
      sourcesOk:        okSources.length,
      latencyMs:        Date.now() - t0,
      tokens:           decomp.tokens + synth.tokens,
      costUsd:          Number((decomp.costUsd + synth.costUsd).toFixed(6)),
    },
  }
  if (ingestedKgNodeId) result.ingestedKgNodeId = ingestedKgNodeId

  // R646d — always persist research result so any future research.share can target it
  try {
    const { persistResearch } = await import('./r646-misc.js')
    await persistResearch(workspaceId, question, result as unknown as Record<string, unknown>)
  } catch { /* tolerated */ }

  return result
}
