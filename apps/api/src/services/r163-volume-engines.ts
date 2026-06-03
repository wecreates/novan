/**
 * R163 — Volume engines: text repurposing + trend-to-publish + competitor watch.
 *
 * One source-of-truth → many platform-tuned variants. Combined with R160
 * PAI loop + R161 audience self-improve, this multiplies effective output
 * by 5-10x without new ideation.
 *
 * Repurposing is rule-based deterministic split; LLM polish is a future
 * slot. Trend-to-draft consumes existing trend_findings rows. Competitor
 * watch tracks handles + records "winners" for gap analysis.
 */
import { db } from '../db/client.js'
import {
  repurposePack, repurposeVariant, competitorHandle, competitorWinner,
  trendFindings, videoPaiLesson,
} from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Repurposing ─────────────────────────────────────────────────────

const DEFAULT_FORMATS: Array<'tweet' | 'short_hook' | 'blog_section' | 'email_subject' | 'ig_caption' | 'thread' | 'yt_title'> = [
  'tweet', 'short_hook', 'blog_section', 'email_subject', 'ig_caption', 'thread', 'yt_title',
]

const LIMITS: Record<string, number> = {
  tweet:         280,
  short_hook:    140,
  email_subject: 80,
  ig_caption:    2200,
  blog_section:  4000,
  thread:        2800,
  yt_title:      100,
}

function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length >= 12)
}

function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length >= 40)
}

function clamp(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const last = cut.lastIndexOf(' ')
  return (last > max * 0.6 ? cut.slice(0, last) : cut) + '…'
}

function makeTweets(sents: string[], n: number): string[] {
  return sents
    .filter(s => s.length >= 40 && s.length <= (LIMITS['tweet'] ?? 280))
    .slice(0, n * 2)
    .map(s => clamp(s, (LIMITS['tweet'] ?? 280)))
    .slice(0, n)
}

function makeHooks(sents: string[], n: number): string[] {
  // Hooks: short, punchy, often question/exclamation/numeric.
  return sents
    .filter(s => s.length <= 140 && /^(why|how|what|the|stop|never|one|3|5|7|10|i |you )/i.test(s))
    .slice(0, n)
    .map(s => clamp(s, (LIMITS['short_hook'] ?? 140)))
}

function makeBlogSections(paras: string[], n: number): string[] {
  return paras.slice(0, n).map(p => clamp(p, (LIMITS['blog_section'] ?? 4000)))
}

function makeEmailSubjects(sents: string[], title: string | undefined, n: number): string[] {
  const out = new Set<string>()
  if (title) out.add(clamp(title, (LIMITS['email_subject'] ?? 80)))
  for (const s of sents) {
    if (out.size >= n) break
    const candidate = s.split(',')[0]?.split('—')[0]?.trim() ?? ''
    if (candidate.length >= 18 && candidate.length <= 70) out.add(clamp(candidate, (LIMITS['email_subject'] ?? 80)))
  }
  return [...out].slice(0, n)
}

function makeIgCaptions(paras: string[], n: number): string[] {
  return paras.slice(0, n).map(p => {
    const head = p.split('.').slice(0, 3).join('.') + '.'
    return clamp(head + '\n\n.\n.\n.\n#growth #builder', (LIMITS['ig_caption'] ?? 2200))
  })
}

function makeThread(sents: string[], maxTweets = 8): string[] {
  // One thread: 5-8 tweets, numbered.
  const used: string[] = []
  for (const s of sents) {
    if (used.length >= maxTweets) break
    if (s.length >= 40 && s.length <= 240) used.push(s)
  }
  if (used.length < 3) return []
  return [used.map((s, i) => `${i + 1}/ ${s}`).join('\n\n').slice(0, 2800)]
}

function makeYtTitles(sents: string[], title: string | undefined, n: number): string[] {
  const out = new Set<string>()
  if (title) out.add(clamp(title, (LIMITS['yt_title'] ?? 100)))
  for (const s of sents) {
    if (out.size >= n) break
    if (s.length >= 24 && s.length <= 90) out.add(clamp(s, (LIMITS['yt_title'] ?? 100)))
  }
  return [...out].slice(0, n)
}

export interface RepurposeInput {
  sourceBody:   string
  title?:       string
  businessId?:  string
  sourceKind?:  'text' | 'video_transcript' | 'blog' | 'email'
  sourceRef?:   string
  formats?:     Array<typeof DEFAULT_FORMATS[number]>
  perFormat?:   number
}

export async function repurposeCreate(workspaceId: string, input: RepurposeInput): Promise<{ packId: string; variantCount: number; perFormat: Record<string, number> }> {
  if (!input.sourceBody || input.sourceBody.length < 80) throw new Error('sourceBody too short (≥80 chars)')
  const formats = input.formats ?? DEFAULT_FORMATS
  const N = Math.max(1, Math.min(input.perFormat ?? 5, 20))
  const packId = uuidv7()
  const now = Date.now()

  await db.insert(repurposePack).values({
    id: packId, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    sourceKind: input.sourceKind ?? 'text',
    ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
    sourceBody: input.sourceBody.slice(0, 200_000),
    ...(input.title ? { title: input.title.slice(0, 200) } : {}),
    status: 'ready',
    createdAt: now,
  })

  const sents = sentences(input.sourceBody)
  const paras = paragraphs(input.sourceBody)

  const perFormat: Record<string, number> = {}
  const rows: Array<typeof repurposeVariant.$inferInsert> = []
  for (const fmt of formats) {
    let bodies: string[] = []
    switch (fmt) {
      case 'tweet':         bodies = makeTweets(sents, N); break
      case 'short_hook':    bodies = makeHooks(sents, N); break
      case 'blog_section':  bodies = makeBlogSections(paras, N); break
      case 'email_subject': bodies = makeEmailSubjects(sents, input.title, N); break
      case 'ig_caption':    bodies = makeIgCaptions(paras, N); break
      case 'thread':        bodies = makeThread(sents); break
      case 'yt_title':      bodies = makeYtTitles(sents, input.title, N); break
    }
    perFormat[fmt] = bodies.length
    for (const body of bodies) {
      rows.push({
        id: uuidv7(), workspaceId, packId, format: fmt, body,
        createdAt: now,
      })
    }
  }
  if (rows.length > 0) await db.insert(repurposeVariant).values(rows)
  await db.update(repurposePack).set({ variantCount: rows.length }).where(eq(repurposePack.id, packId))
  return { packId, variantCount: rows.length, perFormat }
}

export async function repurposeListPacks(workspaceId: string, opts: { limit?: number } = {}): Promise<Array<typeof repurposePack.$inferSelect>> {
  return db.select().from(repurposePack)
    .where(eq(repurposePack.workspaceId, workspaceId))
    .orderBy(desc(repurposePack.createdAt))
    .limit(Math.min(opts.limit ?? 30, 100))
}

export async function repurposeVariants(workspaceId: string, opts: { packId?: string; format?: string; limit?: number } = {}): Promise<Array<typeof repurposeVariant.$inferSelect>> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const filters = [eq(repurposeVariant.workspaceId, workspaceId)]
  if (opts.packId) filters.push(eq(repurposeVariant.packId, opts.packId))
  if (opts.format) filters.push(eq(repurposeVariant.format, opts.format))
  return db.select().from(repurposeVariant).where(and(...filters)).orderBy(desc(repurposeVariant.createdAt)).limit(limit)
}

// ─── Trend → draft ──────────────────────────────────────────────────

/**
 * Turn a trend_findings row into a repurposable pack of social-ready
 * variants. The trend body becomes the source — operator/agent later
 * sends or schedules the variants. ≤24h speed-to-publish is the win.
 */
export async function trendToDraft(workspaceId: string, trendId: string): Promise<{ packId: string; variantCount: number } | { error: string }> {
  const [t] = await db.select().from(trendFindings)
    .where(and(eq(trendFindings.workspaceId, workspaceId), eq(trendFindings.id, trendId)))
    .limit(1)
  if (!t) return { error: 'trend not found' }
  const tt = t as unknown as { headline?: string; summary?: string; body?: string; title?: string; topic?: string }
  const title = tt.headline ?? tt.title ?? tt.topic ?? 'Trend'
  const body  = tt.summary ?? tt.body ?? title
  if (!body || body.length < 80) {
    // Pad with title to meet min length.
    const padded = `${title}\n\n${body}\n\nWhy now: this is gaining real traction. What it means for builders: act before saturation.`
    return repurposeCreate(workspaceId, { sourceBody: padded, title, sourceKind: 'text', sourceRef: `trend:${trendId}` })
      .then(r => ({ packId: r.packId, variantCount: r.variantCount }))
  }
  const r = await repurposeCreate(workspaceId, { sourceBody: body, title, sourceKind: 'text', sourceRef: `trend:${trendId}` })
  return { packId: r.packId, variantCount: r.variantCount }
}

export async function trendListFresh(workspaceId: string, opts: { sinceHours?: number; limit?: number } = {}): Promise<Array<typeof trendFindings.$inferSelect>> {
  const since = Date.now() - (opts.sinceHours ?? 48) * 60 * 60_000
  return db.select().from(trendFindings)
    .where(and(eq(trendFindings.workspaceId, workspaceId), gte(trendFindings.capturedAt, since)))
    .orderBy(desc(trendFindings.capturedAt))
    .limit(Math.min(opts.limit ?? 20, 100))
    .catch(() => [])
}

// ─── Competitor watch ──────────────────────────────────────────────

export interface AddCompetitorInput {
  platform: 'youtube' | 'tiktok' | 'instagram' | 'x' | 'other'
  handle:   string
  niche?:   string
  notes?:   string
  businessId?: string
}

export async function competitorAdd(workspaceId: string, input: AddCompetitorInput): Promise<{ id: string; deduped: boolean }> {
  const handle = input.handle.replace(/^@/, '').trim()
  if (!handle) throw new Error('handle required')
  const [existing] = await db.select({ id: competitorHandle.id }).from(competitorHandle)
    .where(and(
      eq(competitorHandle.workspaceId, workspaceId),
      eq(competitorHandle.platform, input.platform),
      eq(competitorHandle.handle, handle),
    )).limit(1)
  if (existing) return { id: existing.id, deduped: true }
  const id = uuidv7()
  await db.insert(competitorHandle).values({
    id, workspaceId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    platform: input.platform, handle,
    ...(input.niche ? { niche: input.niche } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    status: 'active',
    addedAt: Date.now(),
  })
  return { id, deduped: false }
}

export async function competitorList(workspaceId: string, opts: { businessId?: string; limit?: number } = {}): Promise<Array<typeof competitorHandle.$inferSelect>> {
  const filters = [eq(competitorHandle.workspaceId, workspaceId), eq(competitorHandle.status, 'active')]
  if (opts.businessId) filters.push(eq(competitorHandle.businessId, opts.businessId))
  return db.select().from(competitorHandle).where(and(...filters)).orderBy(desc(competitorHandle.addedAt)).limit(Math.min(opts.limit ?? 50, 200))
}

/**
 * Record a "winner" post — content from a competitor that demonstrably
 * performed. Operator can paste it in, or a future scrape job can fill.
 * Themes get extracted via cheap tokenization (same engine as r161).
 */
export async function competitorRecordWinner(workspaceId: string, input: {
  competitorId: string
  body:         string
  externalId?:  string
  metricScore?: number
  theme?:       string
}): Promise<{ id: string }> {
  if (!input.body || input.body.length < 10) throw new Error('body required')
  const id = uuidv7()
  // Cheap theme extraction (reuse first noun-ish token if no theme given).
  const theme = input.theme ?? (() => {
    const tokens = input.body.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4)
    return tokens[0] ?? null
  })()
  await db.insert(competitorWinner).values({
    id, workspaceId,
    competitorId: input.competitorId,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    body: input.body.slice(0, 6000),
    ...(input.metricScore !== undefined ? { metricScore: input.metricScore } : {}),
    ...(theme ? { theme } : {}),
    recordedAt: Date.now(),
    source: 'agent',
  })
  return { id }
}

/**
 * Find themes the competitor cohort hits that our own audience-loved
 * themes (from R161 social_comment_theme) don't already cover. Mints PAI
 * lessons so the next THINK phase considers these as content angles.
 *
 * Simple rule: any competitor theme with >=3 winners that isn't already
 * a topic on our existing lesson rows → mint "audience-likely" lesson.
 */
export async function competitorGaps(workspaceId: string): Promise<{ gaps: Array<{ theme: string; count: number }>; lessonsMinted: number }> {
  const winners = await db.select({
    theme: competitorWinner.theme, n: sql<number>`count(*)::int`,
  })
    .from(competitorWinner)
    .where(eq(competitorWinner.workspaceId, workspaceId))
    .groupBy(competitorWinner.theme)
  const compThemes = winners.filter(w => w.theme && Number(w.n) >= 3).map(w => ({ theme: w.theme as string, count: Number(w.n) }))

  // Check existing lessons (any topic) — if a lesson mentions the theme word, skip.
  const lessons = await db.select({ pattern: videoPaiLesson.pattern })
    .from(videoPaiLesson)
    .where(eq(videoPaiLesson.workspaceId, workspaceId))
  const known = new Set<string>()
  for (const l of lessons) {
    const lc = l.pattern.toLowerCase()
    for (const t of compThemes) if (lc.includes(t.theme.toLowerCase())) known.add(t.theme)
  }
  const gaps = compThemes.filter(t => !known.has(t.theme))

  let minted = 0
  for (const g of gaps) {
    await db.insert(videoPaiLesson).values({
      id: uuidv7(), workspaceId,
      topic: 'competitor-gap',
      pattern: `Competitors win with "${g.theme}" (${g.count} hits). We have nothing on this topic — strong content opportunity.`,
      evidence: { theme: g.theme, count: g.count, source: 'competitor-watch' },
      confidence: Math.min(0.9, 0.55 + g.count / 20),
      uses: 0, wins: 0, losses: 0,
      createdAt: Date.now(),
    })
    minted += 1
  }
  return { gaps, lessonsMinted: minted }
}
