/**
 * R632 — Research polish: source quality scoring, citation export, multi-language.
 *
 *   research.score_source   — heuristic + LLM-light score of a URL/snippet
 *                             (domain trust, recency, density, content-farm flags)
 *   research.cite           — format a citation list into BibTeX or MLA
 *   research.deep_multilang — like R618.researchDeep but with DDG region+lang
 *                             params; queries fan out across N languages
 */
import type { ResearchSource } from './r618-research-deep.js'

// ─── C5 source quality scoring ──────────────────────────────────────────────

const HIGH_TRUST_DOMAINS = new Set([
  'wikipedia.org', 'github.com', 'arxiv.org', 'nature.com', 'sciencedirect.com',
  'acm.org', 'ieee.org', 'nih.gov', 'cdc.gov', 'who.int', 'reuters.com', 'apnews.com',
  'bbc.co.uk', 'bbc.com', 'nytimes.com', 'theguardian.com', 'economist.com',
  'mit.edu', 'stanford.edu', 'harvard.edu', 'berkeley.edu',
  'docs.python.org', 'developer.mozilla.org', 'docs.microsoft.com', 'docs.aws.amazon.com',
])

const MED_TRUST_DOMAINS = new Set([
  'medium.com', 'substack.com', 'stackoverflow.com', 'reddit.com', 'ycombinator.com',
  'techcrunch.com', 'arstechnica.com', 'wired.com', 'theverge.com',
])

const CONTENT_FARM_FLAGS = [
  /\bclickbait\b/i, /you (won't|wont) believe/i, /\b(top|best) \d+\b/i,
  /sponsored by/i, /this one weird trick/i,
]

export interface SourceQuality {
  url:        string
  domain:     string
  trust:      'high' | 'medium' | 'low' | 'unknown'
  score:      number       // 0-100
  flags:      string[]
  strengths:  string[]
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

export function scoreSource(input: { url: string; snippet?: string; publishedAt?: number }): SourceQuality {
  const domain = domainOf(input.url)
  const flags: string[] = []
  const strengths: string[] = []
  let score = 50    // start neutral
  let trust: SourceQuality['trust'] = 'unknown'

  // 1) Domain reputation
  if (HIGH_TRUST_DOMAINS.has(domain) || [...HIGH_TRUST_DOMAINS].some(d => domain.endsWith('.' + d))) {
    score += 30; trust = 'high'; strengths.push(`high-trust domain: ${domain}`)
  } else if (MED_TRUST_DOMAINS.has(domain) || [...MED_TRUST_DOMAINS].some(d => domain.endsWith('.' + d))) {
    score += 10; trust = 'medium'; strengths.push(`mid-trust platform: ${domain}`)
  } else if (domain.endsWith('.gov') || domain.endsWith('.edu')) {
    score += 25; trust = 'high'; strengths.push(`.gov/.edu domain`)
  } else if (!domain) {
    score -= 15; flags.push('invalid URL')
  } else {
    trust = 'low'
  }

  // 2) Recency (if known)
  if (typeof input.publishedAt === 'number') {
    const ageDays = (Date.now() - input.publishedAt) / 86_400_000
    if (ageDays < 30) { score += 10; strengths.push('recent (<30d)') }
    else if (ageDays > 365 * 5) { score -= 5; flags.push('older than 5 years') }
  }

  // 3) Snippet quality / content-farm flags
  if (input.snippet) {
    const s = input.snippet
    for (const pat of CONTENT_FARM_FLAGS) if (pat.test(s)) { score -= 8; flags.push(`content-farm pattern: ${pat.source}`) }
    if (s.length < 60) { score -= 5; flags.push('snippet too short') }
    const sentences = s.split(/[.!?]\s+/).filter(x => x.trim().length > 10).length
    if (sentences >= 3) { score += 5; strengths.push('coherent multi-sentence snippet') }
  }

  return { url: input.url, domain, trust, score: Math.max(0, Math.min(100, score)), flags, strengths }
}

export function scoreSources(sources: ResearchSource[]): Array<SourceQuality & { citationId: number }> {
  return sources.map(s => ({ citationId: s.citationId, ...scoreSource({ url: s.url, snippet: s.snippet, publishedAt: s.fetchedAt }) }))
}

// ─── C6 citation export ─────────────────────────────────────────────────────

export interface CiteInput {
  title:    string
  authors?: string[]
  url:      string
  publishedAt?: number     // ms epoch
  publisher?: string
  accessedAt?: number      // defaults to now
}

function fmtMlaDate(ms: number): string {
  const d = new Date(ms)
  const months = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.']
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

export function toBibtex(c: CiteInput, key?: string): string {
  const slug = (c.authors?.[0] ?? c.title).split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? 'src'
  const year = c.publishedAt ? new Date(c.publishedAt).getUTCFullYear() : new Date().getUTCFullYear()
  const k = key ?? `${slug}${year}`
  const lines = [
    `@misc{${k},`,
    `  title  = {${c.title.replace(/[{}]/g, '')}},`,
    c.authors?.length ? `  author = {${c.authors.join(' and ')}},` : '',
    `  url    = {${c.url}},`,
    `  year   = {${year}},`,
    c.publisher ? `  publisher = {${c.publisher}},` : '',
    `  note   = {Accessed: ${fmtMlaDate(c.accessedAt ?? Date.now())}}`,
    `}`,
  ].filter(Boolean)
  return lines.join('\n')
}

export function toMla(c: CiteInput): string {
  const authors = c.authors && c.authors.length > 0
    ? (c.authors.length === 1 ? c.authors[0] : c.authors[0] + ', et al.')
    : ''
  const publisher = c.publisher ?? domainOf(c.url)
  const pubDate = c.publishedAt ? fmtMlaDate(c.publishedAt) : ''
  const accessed = `Accessed ${fmtMlaDate(c.accessedAt ?? Date.now())}`
  return [authors, `"${c.title.replace(/[".]/g, '')}"`, publisher, pubDate, c.url, accessed].filter(Boolean).join('. ') + '.'
}

export function citeFromSources(sources: ResearchSource[], format: 'bibtex' | 'mla'): { format: string; entries: Array<{ citationId: number; text: string }> } {
  const entries = sources.filter(s => s.ok).map(s => {
    const input: CiteInput = { title: s.title, url: s.url, accessedAt: s.fetchedAt }
    return { citationId: s.citationId, text: format === 'bibtex' ? toBibtex(input, `src${s.citationId}`) : toMla(input) }
  })
  return { format, entries }
}

// ─── C7 multi-language deep research ────────────────────────────────────────

export interface MultiLangInput {
  question:  string
  langs?:    string[]       // ISO 639-1 codes, default ['en']
  perLang?:  number         // queries per lang, default 3
  ingestToKg?: boolean
}

export interface MultiLangResult {
  question:   string
  langs:      string[]
  byLang:     Record<string, { sources: ResearchSource[]; subQueries: string[] }>
  unified:    { answer: string; totalSources: number; totalTokens: number }
}

/** Wraps R618 researchDeep — runs it once per language with maxQueries=perLang
 *  by setting recency hint via the prompt prefix. (R618 doesn't expose a lang
 *  param; we cue language via the question itself with a "in <lang>:" prefix.) */
export async function deepMultiLang(workspaceId: string, input: MultiLangInput): Promise<MultiLangResult> {
  if (!input.question?.trim()) throw new Error('question required')
  const langs = input.langs && input.langs.length > 0 ? input.langs : ['en']
  const per = Math.max(2, Math.min(6, input.perLang ?? 3))
  const { researchDeep } = await import('./r618-research-deep.js')

  const byLang: MultiLangResult['byLang'] = {}
  let allSources: ResearchSource[] = []
  let allTokens = 0
  const combinedAnswers: string[] = []

  for (const lang of langs) {
    const q = lang === 'en' ? input.question : `Answer in ${lang}. ${input.question}`
    const r = await researchDeep(workspaceId, { question: q, maxQueries: per, ingestToKg: false })
    byLang[lang] = { sources: r.sources, subQueries: r.subQueries }
    allSources = allSources.concat(r.sources)
    allTokens += r.totals.tokens
    combinedAnswers.push(`### ${lang}\n${r.answer}`)
  }

  return {
    question:   input.question,
    langs,
    byLang,
    unified: {
      answer:       combinedAnswers.join('\n\n'),
      totalSources: allSources.length,
      totalTokens:  allTokens,
    },
  }
}
