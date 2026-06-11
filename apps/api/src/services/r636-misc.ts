/**
 * R636 — Misc closures:
 *   F8  competitor watcher  — periodic scrape of competitor listing URLs, track price drift
 *   H5  push topic subs     — VAPID topic subscription so digests can target subsets
 *   K3  rate-limit per-ws   — token bucket; callers consume + check before expensive ops
 *   K5  kill switch UI      — toggle workspace_settings.killSwitch
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

// ─── F8 Competitor watcher ──────────────────────────────────────────────────

async function ensureCompetitorTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS competitor_listings (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      label         TEXT NOT NULL,
      url           TEXT NOT NULL,
      platform      TEXT,
      last_price    REAL,
      last_title    TEXT,
      last_checked  BIGINT,
      created_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS competitor_history (
      id           TEXT PRIMARY KEY,
      listing_id   TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      price        REAL,
      title        TEXT,
      checked_at   BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS comp_hist_listing_idx ON competitor_history (listing_id, checked_at DESC)`).catch(() => {})
}

export async function trackCompetitor(workspaceId: string, input: { label: string; url: string; platform?: string }): Promise<{ id: string }> {
  await ensureCompetitorTable()
  if (!input.label?.trim() || !input.url?.trim()) throw new Error('label + url required')
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO competitor_listings (id, workspace_id, label, url, platform, created_at)
    VALUES (${id}, ${workspaceId}, ${input.label}, ${input.url}, ${input.platform ?? null}, ${Date.now()})
  `)
  return { id }
}

function extractPriceFromHtml(html: string): number | null {
  // Very rough — looks for $XX.XX patterns + JSON-LD price
  const ld = html.match(/"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/i)
  if (ld) return Number(ld[1])
  const dollar = html.match(/\$\s?(\d{1,4}(?:\.\d{2}))/)
  if (dollar) return Number(dollar[1])
  return null
}

export async function tickCompetitors(workspaceId: string, opts: { maxCount?: number } = {}): Promise<{ checked: number; updated: number; failed: number }> {
  await ensureCompetitorTable()
  const max = Math.max(1, Math.min(20, opts.maxCount ?? 10))
  const r = await db.execute(sql`SELECT id, url FROM competitor_listings WHERE workspace_id = ${workspaceId} ORDER BY COALESCE(last_checked, 0) ASC LIMIT ${max}`).catch(() => [] as unknown[])
  const listings = r as Array<{ id: string; url: string }>
  let updated = 0; let failed = 0
  for (const l of listings) {
    try {
      const resp = await fetch(l.url, { headers: { 'User-Agent': 'Mozilla/5.0 Novan-Watcher/1.0' }, signal: AbortSignal.timeout(20_000) })
      if (!resp.ok) { failed++; continue }
      const html = await resp.text()
      const price = extractPriceFromHtml(html)
      const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? '').slice(0, 200)
      const now = Date.now()
      await db.execute(sql`UPDATE competitor_listings SET last_price = ${price ?? null}, last_title = ${title}, last_checked = ${now} WHERE id = ${l.id}`).catch(() => {})
      await db.execute(sql`INSERT INTO competitor_history (id, listing_id, workspace_id, price, title, checked_at) VALUES (${uuidv7()}, ${l.id}, ${workspaceId}, ${price ?? null}, ${title}, ${now})`).catch(() => {})
      updated++
    } catch { failed++ }
  }
  return { checked: listings.length, updated, failed }
}

export async function listCompetitors(workspaceId: string): Promise<Array<{ id: string; label: string; url: string; platform: string | null; lastPrice: number | null; lastTitle: string | null; lastChecked: number | null }>> {
  await ensureCompetitorTable()
  const r = await db.execute(sql`SELECT id, label, url, platform, last_price, last_title, last_checked FROM competitor_listings WHERE workspace_id = ${workspaceId} ORDER BY label`).catch(() => [] as unknown[])
  return (r as Array<Record<string, unknown>>).map(row => ({
    id: String(row['id']), label: String(row['label']), url: String(row['url']),
    platform: row['platform'] ? String(row['platform']) : null,
    lastPrice: row['last_price'] != null ? Number(row['last_price']) : null,
    lastTitle: row['last_title'] != null ? String(row['last_title']) : null,
    lastChecked: row['last_checked'] != null ? Number(row['last_checked']) : null,
  }))
}

// ─── H5 Push topic subscriptions ────────────────────────────────────────────

async function ensureTopicsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS push_topic_subs (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      subscriber_id TEXT NOT NULL,
      topic         TEXT NOT NULL,
      subscribed_at BIGINT NOT NULL,
      UNIQUE (workspace_id, subscriber_id, topic)
    )
  `).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS push_topic_ws_idx ON push_topic_subs (workspace_id, topic)`).catch(() => {})
}

export async function topicSubscribe(workspaceId: string, input: { subscriberId: string; topic: string }): Promise<{ ok: boolean }> {
  await ensureTopicsTable()
  if (!input.subscriberId?.trim() || !input.topic?.trim()) throw new Error('subscriberId + topic required')
  await db.execute(sql`
    INSERT INTO push_topic_subs (id, workspace_id, subscriber_id, topic, subscribed_at)
    VALUES (${uuidv7()}, ${workspaceId}, ${input.subscriberId}, ${input.topic}, ${Date.now()})
    ON CONFLICT (workspace_id, subscriber_id, topic) DO NOTHING
  `).catch(() => {})
  return { ok: true }
}

export async function topicUnsubscribe(workspaceId: string, input: { subscriberId: string; topic: string }): Promise<{ ok: boolean }> {
  await ensureTopicsTable()
  await db.execute(sql`DELETE FROM push_topic_subs WHERE workspace_id = ${workspaceId} AND subscriber_id = ${input.subscriberId} AND topic = ${input.topic}`).catch(() => {})
  return { ok: true }
}

export async function topicSubscribers(workspaceId: string, topic: string): Promise<{ topic: string; count: number; subscribers: string[] }> {
  await ensureTopicsTable()
  const r = await db.execute(sql`SELECT subscriber_id FROM push_topic_subs WHERE workspace_id = ${workspaceId} AND topic = ${topic}`).catch(() => [] as unknown[])
  const ids = (r as Array<Record<string, unknown>>).map(row => String(row['subscriber_id']))
  return { topic, count: ids.length, subscribers: ids }
}

// ─── K3 Rate-limit per workspace ────────────────────────────────────────────

interface Bucket { tokens: number; lastRefill: number; capacity: number; refillPerSec: number }
const BUCKETS = new Map<string, Bucket>()

export interface RateLimitInput {
  bucketKey:    string         // e.g. 'llm.heavy' or 'image.gen'
  capacity?:    number         // default 60
  refillPerSec?: number        // default 1
}

export interface RateLimitResult {
  ok:          boolean
  tokensLeft:  number
  retryInMs?:  number
}

export function rateLimitConsume(workspaceId: string, input: RateLimitInput): RateLimitResult {
  const key = `${workspaceId}:${input.bucketKey}`
  const cap = Math.max(1, input.capacity ?? 60)
  const refill = Math.max(0.01, input.refillPerSec ?? 1)
  const now = Date.now()
  let b = BUCKETS.get(key)
  if (!b) { b = { tokens: cap, lastRefill: now, capacity: cap, refillPerSec: refill }; BUCKETS.set(key, b) }
  // Refill since last
  const sec = (now - b.lastRefill) / 1000
  b.tokens = Math.min(b.capacity, b.tokens + sec * b.refillPerSec)
  b.lastRefill = now
  if (b.tokens >= 1) {
    b.tokens -= 1
    return { ok: true, tokensLeft: Math.floor(b.tokens) }
  }
  const retryInMs = Math.ceil(((1 - b.tokens) / b.refillPerSec) * 1000)
  return { ok: false, tokensLeft: 0, retryInMs }
}

// ─── K5 Kill switch (workspace_settings) ────────────────────────────────────

async function ensureSettingsTable(): Promise<void> {
  // workspace_settings may pre-exist with a different schema — ALTER columns in defensively.
  await db.execute(sql`CREATE TABLE IF NOT EXISTS workspace_settings (workspace_id TEXT PRIMARY KEY)`).catch(() => {})
  await db.execute(sql`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS kill_switch  BOOLEAN NOT NULL DEFAULT false`).catch(() => {})
  await db.execute(sql`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS paused_until BIGINT`).catch(() => {})
  await db.execute(sql`ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS updated_at   BIGINT`).catch(() => {})
}

export async function killSwitchSet(workspaceId: string, input: { on: boolean; pausedUntil?: number }): Promise<{ ok: boolean }> {
  await ensureSettingsTable()
  const pausedUntil = input.pausedUntil ?? null
  await db.execute(sql`
    INSERT INTO workspace_settings (workspace_id, kill_switch, paused_until, updated_at)
    VALUES (${workspaceId}, ${input.on}, ${pausedUntil}, ${Date.now()})
    ON CONFLICT (workspace_id) DO UPDATE SET
      kill_switch = EXCLUDED.kill_switch, paused_until = EXCLUDED.paused_until, updated_at = EXCLUDED.updated_at
  `).catch(() => {})
  return { ok: true }
}

export async function killSwitchStatus(workspaceId: string): Promise<{ on: boolean; pausedUntil: number | null; updatedAt: number | null }> {
  await ensureSettingsTable()
  const r = await db.execute(sql`SELECT kill_switch, paused_until, updated_at FROM workspace_settings WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
  const row = (r as Array<Record<string, unknown>>)[0]
  if (!row) return { on: false, pausedUntil: null, updatedAt: null }
  const pausedUntil = row['paused_until'] != null ? Number(row['paused_until']) : null
  return {
    on: Boolean(row['kill_switch']),
    pausedUntil,
    updatedAt: row['updated_at'] != null ? Number(row['updated_at']) : null,
  }
}
