/**
 * second-brain.ts — R146.114 — cryptocita-style /raw → /wiki pipeline.
 *
 * 4-step system:
 *   1. drop      — anything (URL/video/text/file) lands in second_brain_raw
 *   2. extract   — LLM compiles each raw row into a wiki article with key
 *                  takeaways + cross-links, embedding for semantic recall
 *   3. direct    — second_brain_config.rules_md holds the CLAUDE.md-style
 *                  rules the librarian agent reads before writing
 *   4. automate  — daily ingest (7am) + daily review (6pm) + weekly audit
 *                  (Sun 9am) crons run the whole thing while operator lives
 *
 * Brain ops registered separately in brain-task.ts. This module is the
 * implementation surface those ops call.
 */
import { db } from '../db/client.js'
import {
  secondBrainRaw, secondBrainArticles, secondBrainConfig, secondBrainReviews,
} from '@ops/db'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { embed } from './embeddings.js'
import { recordAiUsage } from './ai-cost-tracker.js'

const DEFAULT_RULES_MD = `# Second Brain — librarian rules

## How this vault works
- You're the librarian. The wiki/ folder is yours to write and maintain. I won't usually edit it directly.
- raw/ is the inbox. When I drop files there, you process them into the wiki the next time I say "compile."
- Each topic gets its own folder (e.g. ai-agents/) and an _index.md listing the articles in that topic.
- Cross-link everything with [[wiki links]].

## On compile
1. Read the raw item
2. Pick the right topic — or make a new one
3. Write a concise wiki article with key takeaways and links
4. Update the topic's _index.md and master index
5. If a raw file spans multiple topics, split and cross-link

## House style
- Bullet points concise.
- Every article ends with a ## Key Takeaways section.
- File slugs use lowercase-with-hyphens.
`

// ─── Config CRUD ─────────────────────────────────────────────────────

export async function getConfig(workspaceId: string): Promise<{
  rulesMd: string; dailyIngestHour: number; dailyReviewHour: number;
  weeklyAuditDay: number; weeklyAuditHour: number; enabled: boolean;
}> {
  const [row] = await db.select().from(secondBrainConfig).where(eq(secondBrainConfig.workspaceId, workspaceId)).limit(1)
  if (!row) return { rulesMd: DEFAULT_RULES_MD, dailyIngestHour: 7, dailyReviewHour: 18, weeklyAuditDay: 0, weeklyAuditHour: 9, enabled: true }
  return {
    rulesMd: row.rulesMd || DEFAULT_RULES_MD,
    dailyIngestHour: row.dailyIngestHour,
    dailyReviewHour: row.dailyReviewHour,
    weeklyAuditDay: row.weeklyAuditDay,
    weeklyAuditHour: row.weeklyAuditHour,
    enabled: row.enabled,
  }
}

export async function setConfig(workspaceId: string, patch: Partial<{
  rulesMd: string; dailyIngestHour: number; dailyReviewHour: number;
  weeklyAuditDay: number; weeklyAuditHour: number; enabled: boolean;
}>): Promise<void> {
  const cur = await getConfig(workspaceId)
  const next = {
    rulesMd: patch.rulesMd ?? cur.rulesMd,
    dailyIngestHour: clamp(patch.dailyIngestHour ?? cur.dailyIngestHour, 0, 23),
    dailyReviewHour: clamp(patch.dailyReviewHour ?? cur.dailyReviewHour, 0, 23),
    weeklyAuditDay:  clamp(patch.weeklyAuditDay  ?? cur.weeklyAuditDay,  0,  6),
    weeklyAuditHour: clamp(patch.weeklyAuditHour ?? cur.weeklyAuditHour, 0, 23),
    enabled: patch.enabled ?? cur.enabled,
  }
  const now = Date.now()
  await db.insert(secondBrainConfig).values({ workspaceId, ...next, updatedAt: now })
    .onConflictDoUpdate({ target: secondBrainConfig.workspaceId, set: { ...next, updatedAt: now } })
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// ─── 1. Drop ────────────────────────────────────────────────────────

export async function dropSource(args: {
  workspaceId: string
  source:      'url' | 'video' | 'text' | 'file'
  url?:        string
  title?:      string
  content?:    string
  tagsHint?:   string
}): Promise<{ id: string }> {
  const id = uuidv7()
  await db.insert(secondBrainRaw).values({
    id,
    workspaceId: args.workspaceId,
    source:      args.source,
    ...(args.url      ? { url:      args.url }      : {}),
    ...(args.title    ? { title:    args.title }    : {}),
    ...(args.content  ? { content:  args.content }  : {}),
    ...(args.tagsHint ? { tagsHint: args.tagsHint } : {}),
    status:    'queued',
    droppedAt: Date.now(),
  })
  return { id }
}

// ─── 2. Extract / compile ───────────────────────────────────────────

interface CompiledArticle {
  topic:        string
  slug:         string
  title:        string
  body:         string
  keyTakeaways: string[]
  links:        Array<{ to: string; label: string }>
}

const COMPILE_PROMPT = `You are the librarian of an operator's second brain. Read the raw source below and turn it into ONE OR MORE concise wiki articles following the rules.

Rules:
{{rules}}

Topic structure: each article belongs to exactly one topic (lowercase-with-hyphens). If the source spans multiple topics, return multiple articles.

Output STRICT JSON: an array of articles, each with:
  - topic        (lowercase-with-hyphens, e.g. "ai-agents")
  - slug         (lowercase-with-hyphens article id)
  - title        (one line, no markdown)
  - body         (markdown, concise, bullets where natural; ends with "## Key Takeaways" followed by bullets)
  - keyTakeaways (array of 2-6 short strings — same as the bullets in the body)
  - links        (array of {to, label} where to is "<topic>/<slug>" of related articles, label is human text)

Raw source:
TITLE: {{title}}
URL:   {{url}}
HINT:  {{hint}}
BODY (truncated to 4000 chars):
{{body}}

Return ONLY the JSON array. No prose, no fences.`

async function callLlmCompile(workspaceId: string, prompt: string): Promise<CompiledArticle[] | null> {
  const groqKey = process.env['GROQ_API_KEY']
  const geminiKey = process.env['GEMINI_API_KEY']
  const t0 = Date.now()
  const tryParse = (s: string): CompiledArticle[] | null => {
    try {
      const cleaned = s.trim().replace(/^```json\s*|```$/g, '')
      // Some models wrap a single object; coerce to array
      const parsed = JSON.parse(cleaned)
      const arr = Array.isArray(parsed) ? parsed : (parsed.articles || [parsed])
      if (!Array.isArray(arr)) return null
      return arr.map((a: unknown) => {
        const o = a as Partial<CompiledArticle>
        return {
          topic:        String(o.topic ?? 'misc').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 80),
          slug:         String(o.slug  ?? 'untitled').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 120),
          title:        String(o.title ?? 'Untitled').slice(0, 200),
          body:         String(o.body  ?? '').slice(0, 8000),
          keyTakeaways: Array.isArray(o.keyTakeaways) ? o.keyTakeaways.map(String).slice(0, 10) : [],
          links:        Array.isArray(o.links) ? o.links.map((l) => ({ to: String((l as { to?: string }).to ?? ''), label: String((l as { label?: string }).label ?? '') })).filter(l => l.to) : [],
        }
      }).filter(a => a.title && a.body)
    } catch { return null }
  }
  if (groqKey) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3, max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) {
        const d = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
        recordAiUsage({ workspaceId, provider: 'groq', model: 'llama-3.3-70b', promptTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, costUsd: 0.0002, latencyMs: Date.now() - t0, taskType: 'other' })
        return tryParse(d.choices?.[0]?.message?.content ?? '')
      }
    } catch { /* fall through */ }
  }
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) {
        const d = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        recordAiUsage({ workspaceId, provider: 'gemini', model: 'gemini-2.0-flash', promptTokens: 0, outputTokens: 0, costUsd: 0.0001, latencyMs: Date.now() - t0, taskType: 'other' })
        return tryParse(d.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
      }
    } catch { /* fall through */ }
  }
  return null
}

/** Compile one raw row → write articles. Idempotent on rerun (UPSERT by topic+slug). */
export async function compileRaw(workspaceId: string, rawId: string): Promise<{ ok: boolean; articles: number; error?: string }> {
  const [raw] = await db.select().from(secondBrainRaw).where(and(eq(secondBrainRaw.workspaceId, workspaceId), eq(secondBrainRaw.id, rawId))).limit(1)
  if (!raw) return { ok: false, articles: 0, error: 'not-found' }
  if (raw.status === 'compiled') return { ok: true, articles: (raw.articleIds ?? []).length }
  const cfg = await getConfig(workspaceId)
  const prompt = COMPILE_PROMPT
    .replace('{{rules}}', cfg.rulesMd.slice(0, 3000))
    .replace('{{title}}', (raw.title ?? '').slice(0, 200))
    .replace('{{url}}',   raw.url   ?? '')
    .replace('{{hint}}',  raw.tagsHint ?? '')
    .replace('{{body}}',  (raw.content ?? '').slice(0, 4000))
  const articles = await callLlmCompile(workspaceId, prompt)
  if (!articles || articles.length === 0) {
    await db.update(secondBrainRaw).set({ status: 'failed', compileError: 'llm-no-output' }).where(eq(secondBrainRaw.id, rawId))
    return { ok: false, articles: 0, error: 'llm-no-output' }
  }
  const writtenIds: string[] = []
  for (const a of articles) {
    const id = uuidv7()
    const now = Date.now()
    const v = await embed(`${a.topic}: ${a.title}\n${a.body.slice(0, 2000)}`).catch(() => null)
    const padded = v ? (v.length === 1536 ? v : v.length > 1536 ? v.slice(0, 1536) : [...v, ...new Array(1536 - v.length).fill(0)]) : null
    try {
      await db.insert(secondBrainArticles).values({
        id, workspaceId,
        topic: a.topic, slug: a.slug, title: a.title, body: a.body,
        keyTakeaways: a.keyTakeaways, links: a.links,
        sourceRawIds: [rawId],
        ...(padded ? { embedding: padded } : {}),
        createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [secondBrainArticles.workspaceId, secondBrainArticles.topic, secondBrainArticles.slug],
        set: {
          title: a.title, body: a.body,
          keyTakeaways: a.keyTakeaways, links: a.links,
          updatedAt: now,
          ...(padded ? { embedding: padded } : {}),
        },
      })
      writtenIds.push(id)
    } catch { /* skip on conflict */ }
  }
  await db.update(secondBrainRaw).set({
    status: 'compiled', compiledAt: Date.now(), articleIds: writtenIds,
  }).where(eq(secondBrainRaw.id, rawId))
  return { ok: true, articles: writtenIds.length }
}

/** Daily ingest: compile every queued raw. Returns counts. */
export async function dailyIngest(workspaceId: string, limit = 30): Promise<{ processed: number; ok: number; failed: number }> {
  const queued = await db.select().from(secondBrainRaw)
    .where(and(eq(secondBrainRaw.workspaceId, workspaceId), eq(secondBrainRaw.status, 'queued')))
    .orderBy(desc(secondBrainRaw.droppedAt)).limit(limit)
  let ok = 0, failed = 0
  for (const r of queued) {
    const out = await compileRaw(workspaceId, r.id)
    if (out.ok) ok++; else failed++
  }
  const id = uuidv7()
  await db.insert(secondBrainReviews).values({
    id, workspaceId, kind: 'daily-ingest',
    summary: `Compiled ${ok} of ${queued.length}, ${failed} failed`,
    changedArticleIds: [], gaps: [], brokenLinks: [],
    runAt: Date.now(),
  }).catch(() => null)
  return { processed: queued.length, ok, failed }
}

// ─── 3. Daily review ────────────────────────────────────────────────

export async function dailyReview(workspaceId: string): Promise<{ articleCount: number; recentChanges: number; summary: string }> {
  const since = Date.now() - 24 * 3600_000
  const [tot] = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM second_brain_articles WHERE workspace_id = ${workspaceId}`) as unknown as Array<{ count: number }>
  const recent = await db.select().from(secondBrainArticles).where(and(
    eq(secondBrainArticles.workspaceId, workspaceId),
    gt(secondBrainArticles.updatedAt, since),
  )).limit(50)
  const summary = `${recent.length} article(s) changed in the last 24h across ${new Set(recent.map(r => r.topic)).size} topic(s).`
  const id = uuidv7()
  await db.insert(secondBrainReviews).values({
    id, workspaceId, kind: 'daily-review',
    summary, changedArticleIds: recent.map(r => r.id), gaps: [], brokenLinks: [],
    runAt: Date.now(),
  }).catch(() => null)
  return { articleCount: tot?.count ?? 0, recentChanges: recent.length, summary }
}

// ─── 4. Weekly audit ────────────────────────────────────────────────

export async function weeklyAudit(workspaceId: string): Promise<{ articleCount: number; gaps: string[]; brokenLinks: string[]; summary: string }> {
  const all = await db.select().from(secondBrainArticles).where(eq(secondBrainArticles.workspaceId, workspaceId))
  // Cheap audit: detect broken links (target slug doesn't exist) and topic gaps
  // (a topic with only 1 article is a candidate for backfilling).
  const slugSet = new Set(all.map(a => `${a.topic}/${a.slug}`))
  const broken: string[] = []
  for (const a of all) {
    for (const l of a.links ?? []) {
      if (l.to && !slugSet.has(l.to)) broken.push(`${a.topic}/${a.slug} → ${l.to}`)
    }
  }
  const topicCounts: Record<string, number> = {}
  for (const a of all) topicCounts[a.topic] = (topicCounts[a.topic] ?? 0) + 1
  const gaps = Object.entries(topicCounts).filter(([, n]) => n < 2).map(([t]) => `${t} (only 1 article)`)
  const summary = `${all.length} articles total · ${broken.length} broken links · ${gaps.length} thin topics`
  const id = uuidv7()
  await db.insert(secondBrainReviews).values({
    id, workspaceId, kind: 'weekly-audit',
    summary, changedArticleIds: [], gaps, brokenLinks: broken,
    runAt: Date.now(),
  }).catch(() => null)
  return { articleCount: all.length, gaps, brokenLinks: broken, summary }
}

// ─── Public reads ───────────────────────────────────────────────────

export async function listArticles(workspaceId: string, topic?: string, limit = 50): Promise<unknown[]> {
  const where = topic
    ? and(eq(secondBrainArticles.workspaceId, workspaceId), eq(secondBrainArticles.topic, topic))
    : eq(secondBrainArticles.workspaceId, workspaceId)
  return db.select().from(secondBrainArticles).where(where).orderBy(desc(secondBrainArticles.updatedAt)).limit(Math.max(1, Math.min(500, limit)))
}

export async function listTopics(workspaceId: string): Promise<Array<{ topic: string; count: number; lastUpdated: number }>> {
  const rows = await db.execute<{ topic: string; count: number; last_updated: number }>(sql`
    SELECT topic, COUNT(*)::int AS count, MAX(updated_at)::bigint AS last_updated
    FROM second_brain_articles WHERE workspace_id = ${workspaceId}
    GROUP BY topic ORDER BY MAX(updated_at) DESC`) as unknown as Array<{ topic: string; count: number; last_updated: number }>
  return rows.map(r => ({ topic: r.topic, count: r.count, lastUpdated: Number(r.last_updated) }))
}

export async function stats(workspaceId: string): Promise<{ totalArticles: number; totalRaw: number; queuedRaw: number; topicCount: number; lastReview?: number }> {
  const [s] = await db.execute<{ articles: number; raw: number; queued: number; topics: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM second_brain_articles WHERE workspace_id = ${workspaceId})           AS articles,
      (SELECT COUNT(*)::int FROM second_brain_raw      WHERE workspace_id = ${workspaceId})           AS raw,
      (SELECT COUNT(*)::int FROM second_brain_raw      WHERE workspace_id = ${workspaceId} AND status = 'queued') AS queued,
      (SELECT COUNT(DISTINCT topic)::int FROM second_brain_articles WHERE workspace_id = ${workspaceId}) AS topics
  `) as unknown as Array<{ articles: number; raw: number; queued: number; topics: number }>
  const [last] = await db.select().from(secondBrainReviews).where(eq(secondBrainReviews.workspaceId, workspaceId)).orderBy(desc(secondBrainReviews.runAt)).limit(1)
  return {
    totalArticles: s?.articles ?? 0,
    totalRaw:      s?.raw      ?? 0,
    queuedRaw:     s?.queued   ?? 0,
    topicCount:    s?.topics   ?? 0,
    ...(last ? { lastReview: last.runAt } : {}),
  }
}
