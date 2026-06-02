/**
 * frontier-intel.ts — R146.105 — Novan Frontier Intelligence.
 *
 * 24/7 scanner + distiller + advancer. Pulls top AI breakthroughs from
 * arxiv / HF Papers / GitHub trending / lab blogs / HN / Papers With Code,
 * LLM-distills each into an integration-ready spec, scores by recency ×
 * impact × replicability × applicability-to-Novan-stack, and auto-spawns
 * brain tasks to prototype the high-scorers BEFORE competitors productize.
 *
 * Goal: Novan operates ~6 months ahead of public productization. The
 * window between "paper published on arxiv" and "feature shipped in a
 * competitor" is typically 3-9 months. Novan closes that loop in days.
 *
 * All sources are free. All scanning is zero-cost. The only spend is the
 * LLM distill call (already governed by autonomy budgets).
 */
import { db } from '../db/client.js'
import { frontierSources, frontierFindings, frontierAdvances, events } from '@ops/db'
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { recordAiUsage } from './ai-cost-tracker.js'

// ─── Default source seed (free, no auth required) ─────────────────────────

export const DEFAULT_FRONTIER_SOURCES: Array<{ kind: string; url: string; label: string; scanIntervalSec: number }> = [
  // arXiv cs.AI new submissions — text RSS, no key
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.AI',                                label: 'arXiv cs.AI',           scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.LG',                                label: 'arXiv cs.LG',           scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.CV',                                label: 'arXiv cs.CV (vision)',  scanIntervalSec: 3600 },
  { kind: 'arxiv',           url: 'https://rss.arxiv.org/rss/cs.CL',                                label: 'arXiv cs.CL (NLP)',     scanIntervalSec: 3600 },
  // Hugging Face daily papers — community-curated top picks
  { kind: 'hf-papers',       url: 'https://huggingface.co/api/daily_papers',                        label: 'HF Daily Papers',       scanIntervalSec: 7200 },
  // GitHub trending — proxy via api with stars filter (no auth required for public)
  { kind: 'github-trending', url: 'https://api.github.com/search/repositories?q=ai+OR+llm+OR+diffusion+pushed:>__SINCE__&sort=stars&order=desc&per_page=30', label: 'GitHub trending AI', scanIntervalSec: 21600 },
  // Papers With Code latest
  { kind: 'paperswithcode',  url: 'https://paperswithcode.com/api/v1/papers/?ordering=-published',  label: 'Papers With Code',      scanIntervalSec: 14400 },
  // Lab blogs (RSS)
  { kind: 'rss',             url: 'https://openai.com/blog/rss.xml',                                label: 'OpenAI Blog',           scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://www.anthropic.com/news/rss.xml',                         label: 'Anthropic News',        scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://deepmind.google/blog/rss.xml',                           label: 'DeepMind Blog',         scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://blog.google/technology/ai/rss/',                         label: 'Google AI Blog',        scanIntervalSec: 21600 },
  { kind: 'rss',             url: 'https://ai.meta.com/blog/rss/',                                  label: 'Meta AI Blog',          scanIntervalSec: 21600 },
  // HN front page (free firebase API)
  { kind: 'hn',              url: 'https://hacker-news.firebaseio.com/v0/topstories.json',          label: 'HN Top',                scanIntervalSec: 3600 },
]

export async function seedDefaultSources(workspaceId: string): Promise<{ inserted: number }> {
  const now = Date.now()
  let inserted = 0
  for (const s of DEFAULT_FRONTIER_SOURCES) {
    try {
      await db.insert(frontierSources).values({
        id: uuidv7(),
        workspaceId,
        kind: s.kind,
        url: s.url,
        label: s.label,
        enabled: true,
        scanIntervalSec: s.scanIntervalSec,
        createdAt: now,
      }).onConflictDoNothing()
      inserted++
    } catch { /* dedup */ }
  }
  return { inserted }
}

// ─── Scanners ────────────────────────────────────────────────────────────

interface RawFinding {
  externalId:   string
  externalUrl:  string
  title:        string
  authors?:     string
  publishedAt?: number
  rawAbstract?: string
}

async function fetchWithTimeout(url: string, ms = 30_000, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers: { 'User-Agent': 'NovanFrontier/1.0', ...headers }, signal: AbortSignal.timeout(ms) })
}

function parseRssItems(xml: string): RawFinding[] {
  // Minimal RSS/Atom parse — avoid adding xml2js dep.
  const out: RawFinding[] = []
  const itemRegex = /<(item|entry)[\s\S]*?<\/\1>/g
  const items = xml.match(itemRegex) ?? []
  for (const item of items.slice(0, 50)) {
    const title    = item.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    const link     = item.match(/<link[^>]*>([\s\S]*?)<\/link>/)?.[1]?.trim()
                   ?? item.match(/<link[^>]*href="([^"]+)"/)?.[1]
    const pubStr   = item.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/\1>/)?.[2]
    const summary  = item.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/)?.[2]?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').trim()
    if (!title || !link) continue
    const externalId = link.split('?')[0] ?? link
    out.push({
      externalId,
      externalUrl: link,
      title: title.slice(0, 500),
      ...(pubStr ? { publishedAt: Date.parse(pubStr) || Date.now() } : {}),
      ...(summary ? { rawAbstract: summary.slice(0, 4000) } : {}),
    })
  }
  return out
}

async function scanArxiv(url: string): Promise<RawFinding[]> {
  const res = await fetchWithTimeout(url, 30_000, { Accept: 'application/rss+xml,application/xml' })
  if (!res.ok) return []
  return parseRssItems(await res.text())
}

async function scanRss(url: string): Promise<RawFinding[]> {
  const res = await fetchWithTimeout(url, 30_000, { Accept: 'application/rss+xml,application/xml' })
  if (!res.ok) return []
  return parseRssItems(await res.text())
}

async function scanHfPapers(url: string): Promise<RawFinding[]> {
  const res = await fetchWithTimeout(url, 30_000, { Accept: 'application/json' })
  if (!res.ok) return []
  const data = await res.json() as Array<{ paper?: { id?: string; title?: string; summary?: string; publishedAt?: string; authors?: Array<{ name?: string }> } }>
  return (Array.isArray(data) ? data : []).slice(0, 50).map(d => {
    const p = d.paper ?? {}
    const id = p.id ?? ''
    return {
      externalId:  `hf:${id}`,
      externalUrl: `https://huggingface.co/papers/${id}`,
      title:       (p.title ?? '').slice(0, 500),
      ...(p.authors?.length ? { authors: p.authors.map(a => a.name ?? '').filter(Boolean).slice(0, 8).join(', ') } : {}),
      ...(p.publishedAt ? { publishedAt: Date.parse(p.publishedAt) || Date.now() } : {}),
      ...(p.summary ? { rawAbstract: p.summary.slice(0, 4000) } : {}),
    } satisfies RawFinding
  }).filter(f => f.title && f.externalId !== 'hf:')
}

async function scanGithubTrending(urlTemplate: string): Promise<RawFinding[]> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)
  const url = urlTemplate.replace('__SINCE__', since)
  const res = await fetchWithTimeout(url, 30_000, { Accept: 'application/vnd.github+json' })
  if (!res.ok) return []
  const data = await res.json() as { items?: Array<{ id?: number; full_name?: string; html_url?: string; description?: string; stargazers_count?: number; pushed_at?: string; owner?: { login?: string } }> }
  return (data.items ?? []).slice(0, 30).map(r => ({
    externalId:  `gh:${r.id ?? r.full_name ?? ''}`,
    externalUrl: r.html_url ?? '',
    title:       (r.full_name ?? '').slice(0, 500),
    ...(r.owner?.login ? { authors: r.owner.login } : {}),
    ...(r.pushed_at ? { publishedAt: Date.parse(r.pushed_at) || Date.now() } : {}),
    rawAbstract: `[${r.stargazers_count ?? 0}⭐] ${r.description ?? ''}`.slice(0, 4000),
  })).filter(f => f.title && f.externalUrl)
}

async function scanPapersWithCode(url: string): Promise<RawFinding[]> {
  const res = await fetchWithTimeout(url, 30_000, { Accept: 'application/json' })
  if (!res.ok) return []
  const data = await res.json() as { results?: Array<{ id?: string; title?: string; abstract?: string; published?: string; authors?: string[]; url_abs?: string }> }
  return (data.results ?? []).slice(0, 30).map(p => ({
    externalId:  `pwc:${p.id ?? ''}`,
    externalUrl: p.url_abs ?? `https://paperswithcode.com/paper/${p.id ?? ''}`,
    title:       (p.title ?? '').slice(0, 500),
    ...(p.authors?.length ? { authors: p.authors.slice(0, 8).join(', ') } : {}),
    ...(p.published ? { publishedAt: Date.parse(p.published) || Date.now() } : {}),
    ...(p.abstract ? { rawAbstract: p.abstract.slice(0, 4000) } : {}),
  })).filter(f => f.title && f.externalId !== 'pwc:')
}

async function scanHN(url: string): Promise<RawFinding[]> {
  const res = await fetchWithTimeout(url, 15_000)
  if (!res.ok) return []
  const ids = (await res.json() as number[]).slice(0, 30)
  const stories = await Promise.all(ids.map(async id => {
    try {
      const r = await fetchWithTimeout(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, 8000)
      if (!r.ok) return null
      return await r.json() as { id?: number; title?: string; url?: string; time?: number; by?: string; type?: string }
    } catch { return null }
  }))
  const out: RawFinding[] = []
  for (const s of stories) {
    if (!s || s.type !== 'story' || !s.title || !s.url) continue
    const isAi = /\b(ai|llm|gpt|claude|gemini|llama|mistral|diffusion|transformer|model|ml |neural|embedding|rag|agentic|agent|fine-tun|train|inference)\b/i.test(s.title)
    if (!isAi) continue
    out.push({
      externalId:  `hn:${s.id}`,
      externalUrl: s.url,
      title:       s.title.slice(0, 500),
      ...(s.by ? { authors: s.by } : {}),
      ...(s.time ? { publishedAt: s.time * 1000 } : {}),
      rawAbstract: `[HN] ${s.title}`,
    })
  }
  return out
}

const SCANNERS: Record<string, (url: string) => Promise<RawFinding[]>> = {
  'arxiv':           scanArxiv,
  'rss':             scanRss,
  'hf-papers':       scanHfPapers,
  'github-trending': scanGithubTrending,
  'paperswithcode':  scanPapersWithCode,
  'hn':              scanHN,
}

// ─── Distill + score ───────────────────────────────────────────────────

interface Distilled {
  technique:         string
  claimedCapability: string
  noveltyVsSOTA:     string
  replicabilityNote: string
  integrationVector: string
  scoreRecency:       number
  scoreImpact:        number
  scoreReplicability: number
  scoreApplicability: number
}

const NOVAN_STACK_HINT = `
Novan's stack: TypeScript/Node API + Postgres+pgvector + Redis/BullMQ workers,
multi-LLM router (Anthropic/OpenAI/Gemini/Groq), image gen via
Pollinations/Flux/SDXL, video gen via HF Inference/Kling/Runway, content
production for YouTube/TikTok/Instagram/Shopify/Printful, autonomous brain
ops, RAG with semantic memory, agentic orchestration.
Applicability is high when the finding plugs into ANY of: video/image gen
quality, content ranking, agent reasoning, retrieval, cost reduction,
prompt evolution, multi-modal understanding, automation, deployment.`.trim()

const DISTILL_PROMPT = `You are Novan's Frontier Distiller. Read the paper/repo description below and produce a STRICT JSON object with these keys:
- technique: short canonical name (e.g. "Speculative Decoding", "RAG-Fusion", "LCM-LoRA")
- claimedCapability: one sentence on what new ability the work enables
- noveltyVsSOTA: one sentence on what's actually new vs. prior art
- replicabilityNote: one sentence on whether code/weights/data are available (open vs. proprietary)
- integrationVector: one sentence on how it would plug into the Novan stack
- scoreRecency: integer 0-100 (how fresh — assume 100 for today, decay over weeks)
- scoreImpact: integer 0-100 (how large the claimed gain over SOTA)
- scoreReplicability: integer 0-100 (how reproducible without proprietary deps)
- scoreApplicability: integer 0-100 (how directly it fits Novan's stack & goals)

Output ONLY the JSON, no prose, no fences.

${NOVAN_STACK_HINT}

FINDING:
TITLE: {{title}}
AUTHORS: {{authors}}
ABSTRACT: {{abstract}}`

async function callLlmDistill(workspaceId: string, title: string, authors: string, abstract: string): Promise<Distilled | null> {
  // Use the cheapest serviceable router; this is a high-volume background workload.
  const groqKey = process.env['GROQ_API_KEY']
  const geminiKey = process.env['GEMINI_API_KEY']
  const anthKey = process.env['ANTHROPIC_API_KEY']
  const prompt = DISTILL_PROMPT
    .replace('{{title}}', title.slice(0, 400))
    .replace('{{authors}}', authors.slice(0, 200))
    .replace('{{abstract}}', abstract.slice(0, 3500))
  const t0 = Date.now()
  // Provider order: Groq (fastest cheap) → Gemini Flash → Anthropic Haiku
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2, max_tokens: 600,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const d = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        const content = d.choices?.[0]?.message?.content ?? ''
        recordAiUsage({ workspaceId, provider: 'groq', model: 'llama-3.3-70b', promptTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, costUsd: 0.0001, latencyMs: Date.now() - t0, taskType: 'other' })
        return safeParseDistill(content)
      }
    } catch { /* fall through */ }
  }
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 600, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const d = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        const content = d.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        recordAiUsage({ workspaceId, provider: 'gemini', model: 'gemini-2.0-flash', promptTokens: 0, outputTokens: 0, costUsd: 0.00005, latencyMs: Date.now() - t0, taskType: 'other' })
        return safeParseDistill(content)
      }
    } catch { /* fall through */ }
  }
  if (anthKey) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(45_000),
      })
      if (res.ok) {
        const d = await res.json() as { content?: Array<{ text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } }
        const content = d.content?.[0]?.text ?? ''
        recordAiUsage({ workspaceId, provider: 'anthropic', model: 'claude-haiku-4-5', promptTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0, costUsd: 0.001, latencyMs: Date.now() - t0, taskType: 'other' })
        return safeParseDistill(content)
      }
    } catch { /* fall through */ }
  }
  return null
}

function safeParseDistill(content: string): Distilled | null {
  try {
    const cleaned = content.trim().replace(/^```json\s*|```$/g, '')
    const o = JSON.parse(cleaned) as Partial<Distilled>
    if (!o.technique || !o.claimedCapability) return null
    return {
      technique:          String(o.technique).slice(0, 200),
      claimedCapability:  String(o.claimedCapability).slice(0, 500),
      noveltyVsSOTA:      String(o.noveltyVsSOTA ?? '').slice(0, 500),
      replicabilityNote:  String(o.replicabilityNote ?? '').slice(0, 500),
      integrationVector:  String(o.integrationVector ?? '').slice(0, 500),
      scoreRecency:       clamp01_100(o.scoreRecency),
      scoreImpact:        clamp01_100(o.scoreImpact),
      scoreReplicability: clamp01_100(o.scoreReplicability),
      scoreApplicability: clamp01_100(o.scoreApplicability),
    }
  } catch { return null }
}

function clamp01_100(n: unknown): number {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(100, Math.round(v)))
}

function compositeScore(d: Pick<Distilled, 'scoreRecency' | 'scoreImpact' | 'scoreReplicability' | 'scoreApplicability'>): number {
  // Weighted: applicability 35%, impact 30%, replicability 20%, recency 15%
  return Math.round(d.scoreApplicability * 0.35 + d.scoreImpact * 0.30 + d.scoreReplicability * 0.20 + d.scoreRecency * 0.15)
}

// ─── Tick: scan one source ───────────────────────────────────────────────

export async function scanSourceOnce(workspaceId: string, sourceId: string): Promise<{ raw: number; inserted: number }> {
  const [src] = await db.select().from(frontierSources).where(and(eq(frontierSources.workspaceId, workspaceId), eq(frontierSources.id, sourceId))).limit(1)
  if (!src || !src.enabled) return { raw: 0, inserted: 0 }
  const scanner = SCANNERS[src.kind]
  if (!scanner) return { raw: 0, inserted: 0 }
  let raws: RawFinding[] = []
  try { raws = await scanner(src.url) } catch { raws = [] }
  await db.update(frontierSources).set({ lastScannedAt: Date.now() }).where(eq(frontierSources.id, sourceId))
  const now = Date.now()
  let inserted = 0
  for (const r of raws.slice(0, 60)) {
    try {
      await db.insert(frontierFindings).values({
        id:           uuidv7(),
        workspaceId,
        sourceId,
        externalUrl:  r.externalUrl,
        externalId:   r.externalId,
        title:        r.title,
        ...(r.authors ? { authors: r.authors } : {}),
        ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        discoveredAt: now,
        ...(r.rawAbstract ? { rawAbstract: r.rawAbstract } : {}),
        scoreRecency:       0,
        scoreImpact:        0,
        scoreReplicability: 0,
        scoreApplicability: 0,
        scoreComposite:     0,
        status:             'new',
        createdAt:          now,
        updatedAt:          now,
      }).onConflictDoNothing()
      inserted++
    } catch { /* dedup via unique idx */ }
  }
  return { raw: raws.length, inserted }
}

// ─── Tick: distill N pending ─────────────────────────────────────────────

export async function distillPending(workspaceId: string, limit = 8): Promise<{ distilled: number; queued: number }> {
  const pending = await db.select().from(frontierFindings)
    .where(and(eq(frontierFindings.workspaceId, workspaceId), eq(frontierFindings.status, 'new')))
    .orderBy(desc(frontierFindings.discoveredAt))
    .limit(limit)
  let distilled = 0, queued = 0
  for (const f of pending) {
    const result = await callLlmDistill(workspaceId, f.title, f.authors ?? '', f.rawAbstract ?? '')
    if (!result) continue
    const composite = compositeScore(result)
    const queueForPrototype = composite >= 70
    await db.update(frontierFindings).set({
      technique:          result.technique,
      claimedCapability:  result.claimedCapability,
      noveltyVsSOTA:      result.noveltyVsSOTA,
      replicabilityNote:  result.replicabilityNote,
      integrationVector:  result.integrationVector,
      scoreRecency:       result.scoreRecency,
      scoreImpact:        result.scoreImpact,
      scoreReplicability: result.scoreReplicability,
      scoreApplicability: result.scoreApplicability,
      scoreComposite:     composite,
      status:             queueForPrototype ? 'queued' : 'distilled',
      updatedAt:          Date.now(),
    }).where(eq(frontierFindings.id, f.id))
    distilled++
    if (queueForPrototype) queued++
  }
  return { distilled, queued }
}

// ─── Tick: spawn brain tasks for queued high-scorers ─────────────────────

export async function spawnPrototypeTasks(workspaceId: string, limit = 3): Promise<{ spawned: number }> {
  // Emit an event for each high-scoring finding. The brain orchestrator
  // and operator dashboard both consume frontier.prototype_requested events
  // and can route the work appropriately (LLM-driven design, then code-agent
  // prototype, then human review). No separate queue layer required.
  const queued = await db.select().from(frontierFindings)
    .where(and(eq(frontierFindings.workspaceId, workspaceId), eq(frontierFindings.status, 'queued')))
    .orderBy(desc(frontierFindings.scoreComposite))
    .limit(limit)
  if (queued.length === 0) return { spawned: 0 }
  let spawned = 0
  for (const f of queued) {
    try {
      const evtId = uuidv7()
      await db.insert(events).values({
        id:            evtId,
        workspaceId,
        type:          'frontier.prototype_requested',
        payload:       {
          findingId:         f.id,
          technique:         f.technique,
          claimedCapability: f.claimedCapability,
          integrationVector: f.integrationVector,
          externalUrl:       f.externalUrl,
          title:             f.title,
          scoreComposite:    f.scoreComposite,
        },
        traceId:       uuidv7(),
        correlationId: uuidv7(),
        causationId:   null,
        source:        'frontier-intel',
        version:       1,
        createdAt:     Date.now(),
      })
      await db.update(frontierFindings).set({
        status:          'prototyping',
        prototypeTaskId: evtId,
        updatedAt:       Date.now(),
      }).where(eq(frontierFindings.id, f.id))
      spawned++
    } catch { /* skip */ }
  }
  return { spawned }
}

// ─── Public tick: one full cycle ─────────────────────────────────────────

export async function frontierTick(workspaceId: string): Promise<{ scanned: number; raw: number; inserted: number; distilled: number; queued: number; spawned: number }> {
  // Pick the most-overdue source up to its scan interval.
  const now = Date.now()
  const due = await db.select().from(frontierSources).where(and(
    eq(frontierSources.workspaceId, workspaceId),
    eq(frontierSources.enabled, true),
    or(
      isNull(frontierSources.lastScannedAt),
      sql`${frontierSources.lastScannedAt} + (${frontierSources.scanIntervalSec} * 1000) <= ${now}`,
    ),
  )).limit(3)
  let raw = 0, inserted = 0
  for (const s of due) {
    const r = await scanSourceOnce(workspaceId, s.id)
    raw += r.raw; inserted += r.inserted
  }
  const distill = await distillPending(workspaceId, 8)
  const prot = await spawnPrototypeTasks(workspaceId, 3)
  return { scanned: due.length, raw, inserted, distilled: distill.distilled, queued: distill.queued, spawned: prot.spawned }
}

// ─── Reporting ──────────────────────────────────────────────────────────

export async function listFrontierLedger(workspaceId: string, opts: { limit?: number; minScore?: number; status?: string } = {}): Promise<unknown[]> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const minScore = opts.minScore ?? 0
  const rows = await db.select().from(frontierFindings).where(and(
    eq(frontierFindings.workspaceId, workspaceId),
    gt(frontierFindings.scoreComposite, minScore - 1),
    ...(opts.status ? [eq(frontierFindings.status, opts.status)] : []),
  )).orderBy(desc(frontierFindings.scoreComposite)).limit(limit)
  return rows
}

export async function recordAdvance(args: { workspaceId: string; findingId: string; ahead: 'integrated' | 'prototyped' | 'specced'; monthsAhead?: number; notes?: string }): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(frontierAdvances).values({
    id,
    workspaceId: args.workspaceId,
    findingId:   args.findingId,
    ahead:       args.ahead,
    monthsAhead: args.monthsAhead ?? estimateMonthsAhead(args.ahead),
    ...(args.notes ? { notes: args.notes } : {}),
    recordedAt:  Date.now(),
  })
  if (args.ahead === 'integrated') {
    await db.update(frontierFindings).set({ status: 'integrated', integratedAt: Date.now(), updatedAt: Date.now() }).where(eq(frontierFindings.id, args.findingId))
  }
  return { id }
}

function estimateMonthsAhead(ahead: 'integrated' | 'prototyped' | 'specced'): number {
  // Heuristic: industry typically takes 3-9mo from publication to product.
  // Novan integrated = ~6mo ahead; prototyped = ~4mo; specced = ~2mo.
  if (ahead === 'integrated') return 6
  if (ahead === 'prototyped') return 4
  return 2
}

export async function frontierStats(workspaceId: string): Promise<{ totalFindings: number; queued: number; prototyping: number; integrated: number; avgMonthsAhead: number }> {
  const [counts] = await db.execute<{ total: number; queued: number; prototyping: number; integrated: number }>(sql`
    SELECT
      COUNT(*)::int                                              AS total,
      COUNT(*) FILTER (WHERE status='queued')::int               AS queued,
      COUNT(*) FILTER (WHERE status='prototyping')::int          AS prototyping,
      COUNT(*) FILTER (WHERE status='integrated')::int           AS integrated
    FROM frontier_findings WHERE workspace_id = ${workspaceId}`) as unknown as Array<{ total: number; queued: number; prototyping: number; integrated: number }>
  const [avg] = await db.execute<{ avg: number }>(sql`
    SELECT COALESCE(AVG(months_ahead), 0)::real AS avg
    FROM frontier_advances WHERE workspace_id = ${workspaceId} AND recorded_at > ${Date.now() - 90 * 86400_000}`) as unknown as Array<{ avg: number }>
  return {
    totalFindings:  counts?.total ?? 0,
    queued:         counts?.queued ?? 0,
    prototyping:    counts?.prototyping ?? 0,
    integrated:     counts?.integrated ?? 0,
    avgMonthsAhead: Number(avg?.avg ?? 0),
  }
}
