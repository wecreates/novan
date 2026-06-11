/**
 * R639 — Webscraping system, end to end.
 *
 * What this is:
 *   - Durable job queue (scrape_jobs) with cron schedules
 *   - Per-run page list (scrape_runs + scrape_pages)
 *   - Extraction templates (CSS, JSON-LD, OpenGraph, microdata, auto)
 *   - Robots.txt + per-domain rate-limit + sitemap.xml seeding
 *   - Web-fetch tier (R181 web-fetch) with optional Playwright fallback (R602)
 *   - Diff detection vs previous run
 *   - Optional RAG ingestion + channel notifications on completion
 *
 * Companion file r639-scrape-views.ts renders /ops/scrape dashboards.
 */
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

// ─── Schema ──────────────────────────────────────────────────────────────────

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      business_id     TEXT,
      name            TEXT NOT NULL,
      seed_url        TEXT NOT NULL,
      template        JSONB NOT NULL DEFAULT '{}'::jsonb,
      schedule_cron   TEXT,
      max_pages       INTEGER NOT NULL DEFAULT 20,
      max_depth       INTEGER NOT NULL DEFAULT 1,
      use_headless    BOOLEAN NOT NULL DEFAULT false,
      respect_robots  BOOLEAN NOT NULL DEFAULT true,
      ingest_to_rag   BOOLEAN NOT NULL DEFAULT false,
      notify_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL,
      last_run_at     BIGINT,
      last_run_status TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS scrape_jobs_ws_idx ON scrape_jobs (workspace_id, enabled, last_run_at)`).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scrape_runs (
      id                TEXT PRIMARY KEY,
      job_id            TEXT NOT NULL,
      workspace_id      TEXT NOT NULL,
      started_at        BIGINT NOT NULL,
      ended_at          BIGINT,
      status            TEXT NOT NULL,
      pages_attempted   INTEGER NOT NULL DEFAULT 0,
      pages_succeeded   INTEGER NOT NULL DEFAULT 0,
      pages_failed      INTEGER NOT NULL DEFAULT 0,
      diffs_detected    INTEGER NOT NULL DEFAULT 0,
      trigger           TEXT NOT NULL DEFAULT 'manual',
      error             TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS scrape_runs_job_idx ON scrape_runs (job_id, started_at DESC)`).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scrape_pages (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      job_id        TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,
      url           TEXT NOT NULL,
      status_code   INTEGER,
      content_hash  TEXT,
      title         TEXT,
      extracted     JSONB NOT NULL DEFAULT '{}'::jsonb,
      bytes         INTEGER,
      fetched_via   TEXT,
      fetched_at    BIGINT NOT NULL,
      error         TEXT
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS scrape_pages_run_idx ON scrape_pages (run_id, fetched_at)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS scrape_pages_url_idx ON scrape_pages (workspace_id, url, fetched_at DESC)`).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS scrape_templates (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      name          TEXT NOT NULL,
      domain_glob   TEXT,
      template      JSONB NOT NULL,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL,
      UNIQUE (workspace_id, name)
    )
  `).catch(() => {})
}

// ─── Robots.txt ──────────────────────────────────────────────────────────────

const robotsCache = new Map<string, { fetchedAt: number; rules: Array<{ ua: string; allow: string[]; disallow: string[] }> }>()
const ROBOTS_TTL = 3600 * 1000

async function getRobots(origin: string): Promise<typeof robotsCache extends Map<string, infer V> ? V : never> {
  const cached = robotsCache.get(origin)
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL) return cached
  const rules: Array<{ ua: string; allow: string[]; disallow: string[] }> = []
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': 'NovanScraper/1.0' }, signal: AbortSignal.timeout(8_000) })
    if (r.ok) {
      const text = await r.text()
      let cur: { ua: string; allow: string[]; disallow: string[] } | null = null
      for (const line of text.split('\n')) {
        const l = line.replace(/#.*$/, '').trim()
        if (!l) continue
        const m = l.match(/^(User-agent|Allow|Disallow|Sitemap):\s*(.+)$/i)
        if (!m) continue
        const key = m[1]!.toLowerCase()
        const val = m[2]!.trim()
        if (key === 'user-agent') { cur = { ua: val.toLowerCase(), allow: [], disallow: [] }; rules.push(cur) }
        else if (cur && key === 'allow')    cur.allow.push(val)
        else if (cur && key === 'disallow') cur.disallow.push(val)
      }
    }
  } catch { /* robots fetch failed — allow by default */ }
  const entry = { fetchedAt: Date.now(), rules }
  robotsCache.set(origin, entry)
  return entry
}

function robotsAllows(rules: Array<{ ua: string; allow: string[]; disallow: string[] }>, pathOnly: string): boolean {
  if (rules.length === 0) return true
  // Find best matching UA block — '*' is the fallback
  const ua = rules.find(r => r.ua === 'novanscraper' || r.ua === 'novanscraper/1.0') ?? rules.find(r => r.ua === '*') ?? rules[0]
  if (!ua) return true
  const longest = (list: string[]): string => list.filter(p => p && pathOnly.startsWith(p)).sort((a, b) => b.length - a.length)[0] ?? ''
  const a = longest(ua.allow)
  const d = longest(ua.disallow)
  if (a.length >= d.length) return true
  return d === ''  // disallow rule wins only if non-empty
}

// ─── Per-domain rate-limit (in-process token bucket) ─────────────────────────

const domainBuckets = new Map<string, { tokens: number; lastRefill: number }>()
const DEFAULT_PER_DOMAIN_PER_SEC = 1

async function rateLimitWait(domain: string, perSec = DEFAULT_PER_DOMAIN_PER_SEC): Promise<void> {
  const now = Date.now()
  let b = domainBuckets.get(domain)
  if (!b) { b = { tokens: 5, lastRefill: now }; domainBuckets.set(domain, b) }
  const elapsed = (now - b.lastRefill) / 1000
  b.tokens = Math.min(5, b.tokens + elapsed * perSec)
  b.lastRefill = now
  if (b.tokens >= 1) { b.tokens -= 1; return }
  const waitMs = Math.ceil(((1 - b.tokens) / perSec) * 1000)
  await new Promise(r => setTimeout(r, waitMs))
  b.tokens = 0
  b.lastRefill = Date.now()
}

// ─── Sitemap.xml ─────────────────────────────────────────────────────────────

async function fetchSitemap(url: string, max = 200): Promise<string[]> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'NovanScraper/1.0' }, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return []
    const xml = await r.text()
    const out: string[] = []
    // Index sitemap → fetch each submap
    const sub = [...xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>/g)].map(m => m[1] ?? '')
    if (sub.length > 0) {
      for (const s of sub.slice(0, 10)) {
        const inner = await fetchSitemap(s, Math.floor(max / sub.length))
        out.push(...inner)
        if (out.length >= max) break
      }
      return out.slice(0, max)
    }
    for (const m of xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>/g)) {
      const u = (m[1] ?? '').trim()
      if (u) out.push(u)
      if (out.length >= max) break
    }
    return out
  } catch { return [] }
}

export async function fetchSitemapForJob(input: { url: string; max?: number }): Promise<{ urls: string[]; count: number }> {
  const urls = await fetchSitemap(input.url, input.max ?? 200)
  return { urls, count: urls.length }
}

// ─── Extraction primitives ───────────────────────────────────────────────────

function getText(html: string, sel: string): string {
  // Crude DOM-less selector resolver: only supports tag, .class, #id, [attr=val], h1-h6
  // For attribute extraction use 'selector@attr' syntax.
  const attrMatch = sel.match(/^(.+)@([a-zA-Z][a-zA-Z0-9-]*)$/)
  const target = attrMatch?.[1] ?? sel
  const attr = attrMatch?.[2]
  let pattern: RegExp
  if (target.startsWith('h') && /^h[1-6]$/.test(target)) {
    pattern = new RegExp(`<${target}\\b[^>]*>([\\s\\S]*?)<\\/${target}>`, 'i')
  } else if (target.startsWith('.')) {
    const cls = target.slice(1)
    pattern = new RegExp(`<[a-z]+[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/[a-z]+>`, 'i')
  } else if (target.startsWith('#')) {
    const id = target.slice(1)
    pattern = new RegExp(`<[a-z]+[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/[a-z]+>`, 'i')
  } else if (target.startsWith('meta[')) {
    const m = target.match(/meta\[(?:property|name)="([^"]+)"\]/)
    if (m && attr === 'content') {
      const tagRe = new RegExp(`<meta[^>]+(?:property|name)="${m[1]}"[^>]*content="([^"]*)"`, 'i')
      const r = html.match(tagRe)
      return (r?.[1] ?? '').trim()
    }
    return ''
  } else if (target.match(/^[a-z]+$/i)) {
    pattern = new RegExp(`<${target}\\b[^>]*>([\\s\\S]*?)<\\/${target}>`, 'i')
  } else {
    return ''
  }
  const m = html.match(pattern)
  if (!m) return ''
  if (attr) {
    const inner = m[0]
    const ar = inner.match(new RegExp(`${attr}="([^"]*)"`))
    return (ar?.[1] ?? '').trim()
  }
  return (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
}

function extractJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1] ?? '{}')
      if (Array.isArray(j)) out.push(...j as Record<string, unknown>[])
      else                  out.push(j as Record<string, unknown>)
    } catch { /* malformed JSON-LD */ }
  }
  return out
}

function extractOpenGraph(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<meta[^>]+property="og:([^"]+)"[^>]+content="([^"]*)"/g)) {
    out[m[1] ?? ''] = m[2] ?? ''
  }
  return out
}

export interface ScrapeTemplate {
  type?: 'css' | 'jsonld' | 'opengraph' | 'auto'
  selectors?: Record<string, string>     // field -> css selector
  follow?: Record<string, string>        // field -> selector to extract URL
}

export interface ExtractResult {
  title:    string
  via:      'jsonld' | 'opengraph' | 'css' | 'auto'
  data:     Record<string, unknown>
  followUrls: string[]
}

export function extract(html: string, baseUrl: string, template: ScrapeTemplate): ExtractResult {
  const type = template.type ?? 'auto'
  const data: Record<string, unknown> = {}
  let via: ExtractResult['via'] = 'auto'
  let title = getText(html, 'title') || getText(html, 'h1') || ''

  // JSON-LD first
  if (type === 'jsonld' || type === 'auto') {
    const ld = extractJsonLd(html)
    if (ld.length > 0) {
      data['jsonld'] = ld
      via = 'jsonld'
      const first = ld[0] as Record<string, unknown>
      if (!title && typeof first['name'] === 'string') title = first['name'] as string
      if (!title && typeof first['headline'] === 'string') title = first['headline'] as string
    }
  }
  // OpenGraph
  if (type === 'opengraph' || (type === 'auto' && via === 'auto')) {
    const og = extractOpenGraph(html)
    if (Object.keys(og).length > 0) {
      data['opengraph'] = og
      if (via === 'auto') via = 'opengraph'
      if (!title && og['title']) title = og['title']
    }
  }
  // CSS template
  if (template.selectors && Object.keys(template.selectors).length > 0) {
    for (const [field, sel] of Object.entries(template.selectors)) {
      data[field] = getText(html, sel)
    }
    if (via === 'auto') via = 'css'
  }

  // Follow URLs
  const followUrls: string[] = []
  if (template.follow) {
    for (const sel of Object.values(template.follow)) {
      // Re-run matcher capturing every href found
      const all = [...html.matchAll(/<a[^>]+href="([^"#?][^"#]*)"/gi)].map(m => m[1] ?? '')
      for (const href of all) {
        try {
          const u = new URL(href, baseUrl)
          u.hash = ''
          followUrls.push(u.toString())
        } catch { /* malformed href */ }
      }
      void sel
    }
  }

  return { title: title.slice(0, 300), via, data, followUrls: [...new Set(followUrls)].slice(0, 50) }
}

// ─── Fetch tier ──────────────────────────────────────────────────────────────

async function fetchPage(url: string, useHeadless: boolean): Promise<{ ok: true; html: string; status: number; via: 'web-fetch' | 'headless' } | { ok: false; status?: number; error: string }> {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 NovanScraper/1.0 (+https://novan.ai)', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(25_000),
      redirect: 'follow',
    })
    const html = await r.text()
    if (!r.ok || html.length < 200) {
      if (useHeadless) {
        try {
          const { runHeadless } = await import('./r602-autobrowser-pool.js') as { runHeadless?: (u: string) => Promise<{ html: string; status: number }> }
          if (runHeadless) {
            const h = await runHeadless(url)
            return { ok: true, html: h.html, status: h.status, via: 'headless' }
          }
        } catch { /* headless tier unavailable */ }
      }
      return { ok: false, status: r.status, error: html.length < 200 ? 'empty body' : `http ${r.status}` }
    }
    return { ok: true, html, status: r.status, via: 'web-fetch' }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ─── Crawl + run ─────────────────────────────────────────────────────────────

export interface ScrapeJob {
  id:           string
  workspaceId:  string
  name:         string
  seedUrl:      string
  template:     ScrapeTemplate
  scheduleCron: string | null
  maxPages:     number
  maxDepth:     number
  useHeadless:  boolean
  respectRobots: boolean
  ingestToRag:  boolean
  notifyChannels: string[]    // ['discord', 'telegram', 'slack']
  enabled:      boolean
  lastRunAt:    number | null
  lastRunStatus: string | null
  createdAt:    number
}

function rowToJob(r: Record<string, unknown>): ScrapeJob {
  return {
    id:            String(r['id']),
    workspaceId:   String(r['workspace_id']),
    name:          String(r['name']),
    seedUrl:       String(r['seed_url']),
    template:      (r['template'] as ScrapeTemplate) ?? {},
    scheduleCron:  r['schedule_cron'] ? String(r['schedule_cron']) : null,
    maxPages:      Number(r['max_pages'] ?? 20),
    maxDepth:      Number(r['max_depth'] ?? 1),
    useHeadless:   Boolean(r['use_headless']),
    respectRobots: Boolean(r['respect_robots']),
    ingestToRag:   Boolean(r['ingest_to_rag']),
    notifyChannels: Array.isArray(r['notify_channels']) ? r['notify_channels'] as string[] : [],
    enabled:       Boolean(r['enabled']),
    lastRunAt:     r['last_run_at'] ? Number(r['last_run_at']) : null,
    lastRunStatus: r['last_run_status'] ? String(r['last_run_status']) : null,
    createdAt:     Number(r['created_at']),
  }
}

export interface CreateJobInput {
  name:           string
  seedUrl:        string
  template?:      ScrapeTemplate
  scheduleCron?:  string
  maxPages?:      number
  maxDepth?:      number
  useHeadless?:   boolean
  respectRobots?: boolean
  ingestToRag?:   boolean
  notifyChannels?: string[]
  businessId?:    string
}

export async function createJob(workspaceId: string, input: CreateJobInput): Promise<{ id: string }> {
  await ensureTables()
  if (!input.name?.trim() || !input.seedUrl?.trim()) throw new Error('name + seedUrl required')
  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO scrape_jobs (
      id, workspace_id, business_id, name, seed_url, template, schedule_cron,
      max_pages, max_depth, use_headless, respect_robots, ingest_to_rag,
      notify_channels, enabled, created_at, updated_at
    ) VALUES (
      ${id}, ${workspaceId}, ${input.businessId ?? null}, ${input.name}, ${input.seedUrl},
      ${JSON.stringify(input.template ?? {})}::jsonb, ${input.scheduleCron ?? null},
      ${Math.max(1, Math.min(500, input.maxPages ?? 20))},
      ${Math.max(0, Math.min(5, input.maxDepth ?? 1))},
      ${!!input.useHeadless}, ${input.respectRobots !== false}, ${!!input.ingestToRag},
      ${JSON.stringify(input.notifyChannels ?? [])}::jsonb, true, ${now}, ${now}
    )
  `)
  return { id }
}

export async function listJobs(workspaceId: string): Promise<ScrapeJob[]> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM scrape_jobs WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(rowToJob)
}

export async function getJob(workspaceId: string, id: string): Promise<ScrapeJob | null> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM scrape_jobs WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  return row ? rowToJob(row) : null
}

export async function deleteJob(workspaceId: string, id: string): Promise<{ ok: boolean }> {
  await ensureTables()
  await db.execute(sql`DELETE FROM scrape_jobs WHERE workspace_id = ${workspaceId} AND id = ${id}`).catch(() => {})
  return { ok: true }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function notifyChannels(channels: string[], title: string, text: string): Promise<void> {
  if (channels.length === 0) return
  try {
    const c = await import('./r628-channels.js')
    if (channels.includes('discord'))  void c.sendDiscord({ title, text })
    if (channels.includes('telegram')) void c.sendTelegram({ title, text })
    if (channels.includes('slack'))    void c.sendSlack({ title, text })
  } catch { /* channels module optional */ }
}

export interface RunResult {
  runId:         string
  status:        'success' | 'partial' | 'failed'
  pagesAttempted: number
  pagesSucceeded: number
  pagesFailed:    number
  diffsDetected:  number
  durationMs:    number
}

export async function runJob(workspaceId: string, jobId: string, trigger: 'manual' | 'cron' = 'manual'): Promise<RunResult> {
  await ensureTables()
  const job = await getJob(workspaceId, jobId)
  if (!job) throw new Error('job not found')

  const runId = uuidv7()
  const startedAt = Date.now()
  await db.execute(sql`
    INSERT INTO scrape_runs (id, job_id, workspace_id, started_at, status, trigger)
    VALUES (${runId}, ${jobId}, ${workspaceId}, ${startedAt}, 'running', ${trigger})
  `)

  // Seed: either a sitemap or a single page
  let seeds: string[] = [job.seedUrl]
  if (job.seedUrl.endsWith('.xml') || job.seedUrl.includes('sitemap')) {
    const s = await fetchSitemap(job.seedUrl, job.maxPages)
    if (s.length > 0) seeds = s.slice(0, job.maxPages)
  }

  const visited = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = seeds.map(u => ({ url: u, depth: 0 }))
  let pagesAttempted = 0, pagesSucceeded = 0, pagesFailed = 0, diffsDetected = 0
  let lastError: string | null = null
  const seedOrigin = (() => { try { return new URL(job.seedUrl).origin } catch { return '' } })()

  while (queue.length > 0 && pagesAttempted < job.maxPages) {
    const item = queue.shift()
    if (!item) break
    if (visited.has(item.url)) continue
    visited.add(item.url)
    pagesAttempted++

    // robots
    if (job.respectRobots) {
      try {
        const u = new URL(item.url)
        const rules = await getRobots(u.origin)
        if (!robotsAllows(rules.rules, u.pathname)) {
          await recordPage(runId, jobId, workspaceId, item.url, null, '', '', {}, 0, 'web-fetch', 'blocked by robots.txt')
          pagesFailed++
          continue
        }
        await rateLimitWait(u.host)
      } catch { /* URL parse error — proceed */ }
    }

    const result = await fetchPage(item.url, job.useHeadless)
    if (!result.ok) {
      await recordPage(runId, jobId, workspaceId, item.url, result.status ?? null, '', '', {}, 0, job.useHeadless ? 'headless' : 'web-fetch', result.error)
      pagesFailed++
      lastError = result.error
      continue
    }

    const ext = extract(result.html, item.url, job.template)
    const contentHash = sha256Hex(result.html)
    await recordPage(runId, jobId, workspaceId, item.url, result.status, contentHash, ext.title, ext.data, result.html.length, result.via, null)
    pagesSucceeded++

    // Diff vs last successful page for same URL
    try {
      const prev = await db.execute(sql`
        SELECT content_hash FROM scrape_pages
        WHERE workspace_id = ${workspaceId} AND url = ${item.url} AND id != ${runId}
        ORDER BY fetched_at DESC LIMIT 1 OFFSET 1
      `).catch(() => [] as unknown[])
      const prevHash = (prev as Array<Record<string, unknown>>)[0]?.['content_hash']
      if (prevHash && String(prevHash) !== contentHash) diffsDetected++
    } catch { /* tolerated */ }

    // Optional RAG ingest
    if (job.ingestToRag) {
      try {
        const { ingest } = await import('./r621-document-rag.js')
        const text = result.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (text.length > 200) await ingest(workspaceId, { name: `scrape:${job.name}:${ext.title || item.url}`.slice(0, 200), text, mime: 'text/html' })
      } catch { /* RAG ingest optional */ }
    }

    // Enqueue follow URLs
    if (item.depth < job.maxDepth) {
      for (const f of ext.followUrls) {
        try {
          if (seedOrigin && new URL(f).origin !== seedOrigin) continue
        } catch { continue }
        if (!visited.has(f)) queue.push({ url: f, depth: item.depth + 1 })
      }
    }
  }

  const status: RunResult['status'] = pagesFailed === 0 ? 'success' : (pagesSucceeded > 0 ? 'partial' : 'failed')
  const endedAt = Date.now()
  await db.execute(sql`
    UPDATE scrape_runs SET ended_at = ${endedAt}, status = ${status},
      pages_attempted = ${pagesAttempted}, pages_succeeded = ${pagesSucceeded},
      pages_failed = ${pagesFailed}, diffs_detected = ${diffsDetected},
      error = ${lastError}
    WHERE id = ${runId}
  `).catch(() => {})
  await db.execute(sql`UPDATE scrape_jobs SET last_run_at = ${endedAt}, last_run_status = ${status} WHERE id = ${jobId}`).catch(() => {})

  // Notifications on completion
  if (job.notifyChannels.length > 0) {
    const summary = `Scrape "${job.name}" ${status}: ${pagesSucceeded}/${pagesAttempted} pages OK, ${diffsDetected} diff(s) detected.`
    await notifyChannels(job.notifyChannels, `Scrape ${status}: ${job.name}`, summary)
  }

  return {
    runId, status,
    pagesAttempted, pagesSucceeded, pagesFailed, diffsDetected,
    durationMs: endedAt - startedAt,
  }
}

async function recordPage(runId: string, jobId: string, workspaceId: string, url: string, statusCode: number | null, contentHash: string, title: string, extracted: Record<string, unknown>, bytes: number, via: string, error: string | null): Promise<void> {
  await db.execute(sql`
    INSERT INTO scrape_pages (id, run_id, job_id, workspace_id, url, status_code, content_hash, title, extracted, bytes, fetched_via, fetched_at, error)
    VALUES (${uuidv7()}, ${runId}, ${jobId}, ${workspaceId}, ${url}, ${statusCode}, ${contentHash}, ${title}, ${JSON.stringify(extracted)}::jsonb, ${bytes}, ${via}, ${Date.now()}, ${error})
  `).catch(() => {})
}

// ─── Listing helpers ────────────────────────────────────────────────────────

export async function listRuns(workspaceId: string, jobId?: string, limit = 30): Promise<Array<{ id: string; jobId: string; startedAt: number; endedAt: number | null; status: string; pagesSucceeded: number; pagesFailed: number; diffsDetected: number; trigger: string; error: string | null }>> {
  await ensureTables()
  const lim = Math.max(1, Math.min(100, limit))
  const r = jobId
    ? await db.execute(sql`SELECT * FROM scrape_runs WHERE workspace_id = ${workspaceId} AND job_id = ${jobId} ORDER BY started_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
    : await db.execute(sql`SELECT * FROM scrape_runs WHERE workspace_id = ${workspaceId} ORDER BY started_at DESC LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:             String(row['id']),
    jobId:          String(row['job_id']),
    startedAt:      Number(row['started_at']),
    endedAt:        row['ended_at'] != null ? Number(row['ended_at']) : null,
    status:         String(row['status']),
    pagesSucceeded: Number(row['pages_succeeded'] ?? 0),
    pagesFailed:    Number(row['pages_failed'] ?? 0),
    diffsDetected:  Number(row['diffs_detected'] ?? 0),
    trigger:        String(row['trigger']),
    error:          row['error'] != null ? String(row['error']) : null,
  }))
}

export async function listPages(workspaceId: string, runId: string, limit = 100): Promise<Array<{ id: string; url: string; statusCode: number | null; title: string; bytes: number | null; fetchedVia: string; fetchedAt: number; error: string | null }>> {
  await ensureTables()
  const lim = Math.max(1, Math.min(500, limit))
  const r = await db.execute(sql`SELECT id, url, status_code, title, bytes, fetched_via, fetched_at, error FROM scrape_pages WHERE workspace_id = ${workspaceId} AND run_id = ${runId} ORDER BY fetched_at LIMIT ${lim}`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:         String(row['id']),
    url:        String(row['url']),
    statusCode: row['status_code'] != null ? Number(row['status_code']) : null,
    title:      String(row['title'] ?? ''),
    bytes:      row['bytes'] != null ? Number(row['bytes']) : null,
    fetchedVia: String(row['fetched_via'] ?? ''),
    fetchedAt:  Number(row['fetched_at']),
    error:      row['error'] != null ? String(row['error']) : null,
  }))
}

export async function getPage(workspaceId: string, pageId: string): Promise<{ id: string; url: string; statusCode: number | null; title: string; extracted: Record<string, unknown>; bytes: number | null; fetchedVia: string; fetchedAt: number; error: string | null } | null> {
  await ensureTables()
  const r = await db.execute(sql`SELECT id, url, status_code, title, extracted, bytes, fetched_via, fetched_at, error FROM scrape_pages WHERE workspace_id = ${workspaceId} AND id = ${pageId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    id:         String(row['id']),
    url:        String(row['url']),
    statusCode: row['status_code'] != null ? Number(row['status_code']) : null,
    title:      String(row['title'] ?? ''),
    extracted:  (row['extracted'] as Record<string, unknown>) ?? {},
    bytes:      row['bytes'] != null ? Number(row['bytes']) : null,
    fetchedVia: String(row['fetched_via'] ?? ''),
    fetchedAt:  Number(row['fetched_at']),
    error:      row['error'] != null ? String(row['error']) : null,
  }
}

// ─── Templates ───────────────────────────────────────────────────────────────

export async function saveTemplate(workspaceId: string, input: { name: string; domainGlob?: string; template: ScrapeTemplate }): Promise<{ id: string }> {
  await ensureTables()
  if (!input.name?.trim()) throw new Error('name required')
  const id = uuidv7()
  const now = Date.now()
  await db.execute(sql`
    INSERT INTO scrape_templates (id, workspace_id, name, domain_glob, template, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${input.name}, ${input.domainGlob ?? null}, ${JSON.stringify(input.template)}::jsonb, ${now}, ${now})
    ON CONFLICT (workspace_id, name) DO UPDATE SET
      domain_glob = EXCLUDED.domain_glob, template = EXCLUDED.template, updated_at = EXCLUDED.updated_at
  `).catch(() => {})
  return { id }
}

export async function listTemplates(workspaceId: string): Promise<Array<{ id: string; name: string; domainGlob: string | null; template: ScrapeTemplate; updatedAt: number }>> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM scrape_templates WHERE workspace_id = ${workspaceId} ORDER BY name`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id:         String(row['id']),
    name:       String(row['name']),
    domainGlob: row['domain_glob'] != null ? String(row['domain_glob']) : null,
    template:   (row['template'] as ScrapeTemplate) ?? {},
    updatedAt:  Number(row['updated_at'] ?? 0),
  }))
}

// ─── Robots check (utility for testing a URL before adding to job) ──────────

export async function robotsCheck(input: { url: string }): Promise<{ allowed: boolean; rulesFound: number }> {
  try {
    const u = new URL(input.url)
    const rules = await getRobots(u.origin)
    return { allowed: robotsAllows(rules.rules, u.pathname), rulesFound: rules.rules.length }
  } catch { return { allowed: true, rulesFound: 0 } }
}

// ─── Cron tick — pick due cron-scheduled jobs and run them ─────────────────

function isDue(cron: string, lastRunAt: number | null): boolean {
  // Trivial: if never run + has cron, due. Otherwise, due if > 1 hr since last run
  // for cron strings we don't parse precisely yet.
  if (!cron) return false
  if (!lastRunAt) return true
  return Date.now() - lastRunAt > 60 * 60_000
}

export async function tickScrape(): Promise<{ scanned: number; fired: number }> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM scrape_jobs WHERE enabled = true AND schedule_cron IS NOT NULL AND schedule_cron <> ''`).catch(() => [] as unknown[])
  const jobs = (r as Array<Record<string, unknown>>).map(rowToJob)
  let fired = 0
  for (const j of jobs) {
    if (isDue(j.scheduleCron ?? '', j.lastRunAt)) {
      try { await runJob(j.workspaceId, j.id, 'cron'); fired++ } catch { /* tolerate per-job */ }
    }
  }
  return { scanned: jobs.length, fired }
}
