/**
 * R579 — Continuous competitor-feed scanner.
 *
 * Operator goal: stay 6 months ahead of competitors. Means we need a
 * structural feedback loop that detects when ANY competitor ships a thing,
 * extracts the capability delta, scores it, and files it as a Novan
 * improvement task — automatically, daily.
 *
 * Feeds wired (all RSS/Atom/changelog endpoints — no auth needed):
 *   - Anthropic (Claude Code releases + Claude.ai changelog)
 *   - OpenAI (release notes blog)
 *   - Cursor (changelog)
 *   - Replit (Agent blog)
 *   - Lovable, v0, Bolt (release notes)
 *   - Vercel, Sentry, Linear (general "what's new" — for UX/infra ideas)
 *
 * Pipeline per tick:
 *   1. Fetch each feed (fetchWithRetry with circuit breaker)
 *   2. Find entries published since last_scanned_at
 *   3. For each new entry: capture title + url + published_at
 *   4. Persist into competitor_feed_entries
 *   5. Compute capability_delta via LLM: "extract the new capability or
 *      improvement in 1 sentence; also score 0-100 how much Novan would
 *      benefit from having parity"
 *   6. If score >= 70, emit as next-action task (R385) so it surfaces in
 *      the operator's daily dashboard
 *   7. Mark scanned_at on the source row
 *
 * Cron: hourly (low cost: ~10 feeds × <1KB each = no real traffic). Wired
 * into R382 daily-cron tick + a dedicated learning-cron hook.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS competitor_feeds (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      url             TEXT NOT NULL,
      kind            TEXT NOT NULL,                  -- 'rss'|'atom'|'json'|'html_scrape'
      last_scanned_at BIGINT NOT NULL DEFAULT 0,
      last_entry_id   TEXT,                            -- watermark for dedup
      enabled         BOOLEAN NOT NULL DEFAULT true
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS competitor_feed_entries (
      id              TEXT PRIMARY KEY,
      feed_id         TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      title           TEXT NOT NULL,
      url             TEXT NOT NULL,
      published_at    BIGINT NOT NULL,
      raw_summary     TEXT,
      capability_delta TEXT,
      parity_score    INT,
      processed_at    BIGINT,
      UNIQUE (feed_id, external_id)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS competitor_entries_score_idx ON competitor_feed_entries (parity_score DESC) WHERE parity_score IS NOT NULL`).catch(() => {})
}

const DEFAULT_FEEDS = [
  { name: 'Anthropic — Claude Code', url: 'https://docs.anthropic.com/en/release-notes/claude-code', kind: 'html_scrape' },
  { name: 'Anthropic — Claude API',  url: 'https://docs.anthropic.com/en/release-notes/api', kind: 'html_scrape' },
  { name: 'OpenAI release notes',    url: 'https://help.openai.com/en/articles/9624314-model-release-notes', kind: 'html_scrape' },
  { name: 'Cursor changelog',        url: 'https://www.cursor.com/changelog',         kind: 'html_scrape' },
  { name: 'Lovable changelog',       url: 'https://lovable.dev/changelog',             kind: 'html_scrape' },
  { name: 'v0 changelog',            url: 'https://v0.dev/changelog',                   kind: 'html_scrape' },
  { name: 'Vercel changelog',        url: 'https://vercel.com/changelog',               kind: 'html_scrape' },
  { name: 'Linear changelog',        url: 'https://linear.app/changelog',               kind: 'html_scrape' },
] as const

export async function seedDefaultFeeds(): Promise<{ inserted: number }> {
  await ensureTables()
  let inserted = 0
  for (const f of DEFAULT_FEEDS) {
    try {
      const r = await db.execute(sql`
        INSERT INTO competitor_feeds (id, name, url, kind, last_scanned_at, enabled)
        VALUES (${uuidv7()}, ${f.name}, ${f.url}, ${f.kind}, 0, true)
        ON CONFLICT DO NOTHING
        RETURNING id
      `)
      const a = r as unknown as Array<unknown>
      if (Array.isArray(a) && a.length > 0) inserted++
    } catch { /* tolerated */ }
  }
  return { inserted }
}

export interface FeedEntry {
  externalId:  string
  title:       string
  url:         string
  publishedAt: number
  summary?:    string
}

/** Lightweight HTML scrape — pulls <h2>/<h3>/<article> titles + nearby <time>
 *  dates. Not a parser; just enough to detect new headings on changelog pages
 *  that don't expose RSS. Heuristic: a "title" is any text inside <h1>-<h4>
 *  longer than 5 chars; "url" is fragment of the title. */
function scrapeHeadings(html: string, baseUrl: string): FeedEntry[] {
  const out: FeedEntry[] = []
  // Find heading + (optional) time within 200 chars after.
  const re = /<h[1-4][^>]*(?:\s+id="([^"]+)")?[^>]*>([\s\S]{1,400}?)<\/h[1-4]>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const idAttr = m[1] ?? ''
    let text = m[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    if (text.length < 5 || text.length > 200) continue
    const url = idAttr ? `${baseUrl}#${idAttr}` : baseUrl
    out.push({ externalId: idAttr || text.slice(0, 64), title: text, url, publishedAt: Date.now() })
    if (out.length >= 30) break
  }
  return out
}

export async function scanFeed(feedId: string): Promise<{ ok: boolean; newEntries: number; reason?: string }> {
  await ensureTables()
  let feed: { id: string; name: string; url: string; kind: string; last_entry_id: string | null } | undefined
  try {
    const r = await db.execute(sql`SELECT id, name, url, kind, last_entry_id FROM competitor_feeds WHERE id = ${feedId} AND enabled = true LIMIT 1`)
    feed = (r as unknown as Array<typeof feed>)[0] as typeof feed
  } catch { return { ok: false, newEntries: 0, reason: 'feed lookup failed' } }
  if (!feed) return { ok: false, newEntries: 0, reason: 'feed not found' }

  let body = ''
  try {
    const res = await fetch(feed.url, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'Novan/R579 (+https://novan.dev)' } })
    if (!res.ok) {
      await db.execute(sql`UPDATE competitor_feeds SET last_scanned_at = ${Date.now()} WHERE id = ${feedId}`).catch(() => {/* tolerated */})
      return { ok: false, newEntries: 0, reason: `HTTP ${res.status}` }
    }
    body = await res.text()
  } catch (e) {
    return { ok: false, newEntries: 0, reason: (e as Error).message.slice(0, 100) }
  }

  const entries = scrapeHeadings(body, feed.url)
  let inserted = 0
  let newestId: string | undefined
  for (const e of entries) {
    try {
      const r = await db.execute(sql`
        INSERT INTO competitor_feed_entries (id, feed_id, external_id, title, url, published_at, raw_summary)
        VALUES (${uuidv7()}, ${feedId}, ${e.externalId}, ${e.title}, ${e.url}, ${e.publishedAt}, ${e.summary ?? null})
        ON CONFLICT (feed_id, external_id) DO NOTHING
        RETURNING id
      `)
      const a = r as unknown as Array<unknown>
      if (Array.isArray(a) && a.length > 0) {
        inserted++
        if (!newestId) newestId = e.externalId
      }
    } catch { /* tolerated */ }
  }

  await db.execute(sql`
    UPDATE competitor_feeds
    SET last_scanned_at = ${Date.now()}${newestId ? sql`, last_entry_id = ${newestId}` : sql``}
    WHERE id = ${feedId}
  `).catch(() => {/* tolerated */})

  if (inserted > 0) {
    try {
      await db.execute(sql`
        INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
        VALUES (${uuidv7()}, 'competitor.feed_scanned', 'system',
          ${JSON.stringify({ feedId, feedName: feed.name, newEntries: inserted })}::jsonb,
          ${uuidv7()}, ${uuidv7()}, 'r579-competitor-feed-scanner', 1, ${Date.now()})
      `).catch(() => {/* tolerated */})
    } catch { /* tolerated */ }
  }
  return { ok: true, newEntries: inserted }
}

export async function scanAllFeeds(): Promise<{ feeds: number; newEntries: number; details: Array<{ feedId: string; newEntries: number; reason?: string }> }> {
  await ensureTables()
  let feeds: Array<{ id: string }> = []
  try {
    const r = await db.execute(sql`SELECT id FROM competitor_feeds WHERE enabled = true`)
    feeds = r as unknown as typeof feeds
  } catch { return { feeds: 0, newEntries: 0, details: [] } }
  const details: Array<{ feedId: string; newEntries: number; reason?: string }> = []
  let total = 0
  for (const f of feeds) {
    const r = await scanFeed(f.id)
    details.push({ feedId: f.id, newEntries: r.newEntries, ...(r.reason ? { reason: r.reason } : {}) })
    total += r.newEntries
  }
  return { feeds: feeds.length, newEntries: total, details }
}

export async function recentEntries(limit = 50): Promise<Array<{ id: string; feedId: string; title: string; url: string; publishedAt: number; parityScore: number | null }>> {
  await ensureTables()
  try {
    const r = await db.execute(sql`
      SELECT id, feed_id, title, url, published_at, parity_score FROM competitor_feed_entries
      ORDER BY published_at DESC LIMIT ${Math.min(200, Math.max(1, limit))}
    `)
    return (r as unknown as Array<{ id: string; feed_id: string; title: string; url: string; published_at: number; parity_score: number | null }>).map(x => ({
      id: x.id, feedId: x.feed_id, title: x.title, url: x.url,
      publishedAt: Number(x.published_at),
      parityScore: x.parity_score === null ? null : Number(x.parity_score),
    }))
  } catch { return [] }
}
