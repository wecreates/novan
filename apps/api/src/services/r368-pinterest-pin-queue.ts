/**
 * R368 — Pinterest pin queue.
 *
 * Holds the operator's batch of pins (typically the 25 from R360) and
 * surfaces them one at a time to the local-agent's Pinterest driver. Tracks
 * status, last-posted timestamps, and enforces a safe-velocity cap.
 *
 * Pinterest's spam filter trips on >5 pins/day from a new account. Cap is
 * enforced server-side via SAFE_PIN_VELOCITY.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

export const SAFE_PIN_VELOCITY = 5     // R350 anti-flag: pins/day max for new accounts
const DAY_MS = 24 * 60 * 60 * 1000

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pinterest_pin_queue (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL,
      tags            TEXT NOT NULL,           -- comma-sep
      link_url        TEXT NOT NULL,           -- the gumroad / etsy product URL
      board_name      TEXT NOT NULL,
      design_file     TEXT,                    -- local path to image
      priority        INTEGER NOT NULL DEFAULT 50,
      status          TEXT NOT NULL DEFAULT 'queued',  -- queued|posted|skipped|failed
      external_url    TEXT,                    -- the live pin URL after posting
      queued_at       BIGINT NOT NULL,
      posted_at       BIGINT,
      notes           TEXT
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS pinterest_pin_queue_ws_status_pri_idx
    ON pinterest_pin_queue (workspace_id, status, priority DESC, queued_at ASC)
  `).catch(() => {})
}

export interface EnqueuePinInput {
  workspaceId:  string
  title:        string
  description:  string
  tags:         string[]
  linkUrl:      string
  boardName:    string
  designFile?:  string
  priority?:    number
  notes?:       string
}

export async function enqueuePin(input: EnqueuePinInput): Promise<{ ok: true; id: string }> {
  await ensureTable()
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO pinterest_pin_queue
      (id, workspace_id, title, description, tags, link_url, board_name, design_file, priority, queued_at, notes)
    VALUES
      (${id}, ${input.workspaceId}, ${input.title.slice(0, 100)}, ${input.description.slice(0, 500)},
       ${input.tags.join(',').slice(0, 500)}, ${input.linkUrl}, ${input.boardName},
       ${input.designFile ?? null}, ${input.priority ?? 50}, ${Date.now()}, ${input.notes ?? null})
  `)
  return { ok: true, id }
}

export interface PinItem {
  id:           string
  title:        string
  description:  string
  tags:         string
  linkUrl:      string
  boardName:    string
  designFile:   string | null
  priority:     number
}

export async function nextPin(workspaceId: string): Promise<PinItem | null> {
  await ensureTable()
  // Check today's velocity first
  const cutoff = Date.now() - DAY_MS
  const todayRows = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM pinterest_pin_queue
    WHERE workspace_id = ${workspaceId} AND status = 'posted' AND posted_at >= ${cutoff}
  `)
  const postedToday = Number((todayRows as unknown as Array<{ n: number }>)[0]?.n ?? 0)
  if (postedToday >= SAFE_PIN_VELOCITY) return null

  const rows = await db.execute(sql`
    SELECT id, title, description, tags, link_url, board_name, design_file, priority
    FROM pinterest_pin_queue
    WHERE workspace_id = ${workspaceId} AND status = 'queued'
    ORDER BY priority DESC, queued_at ASC
    LIMIT 1
  `)
  const r = (rows as unknown as Array<Record<string, unknown>>)[0]
  if (!r) return null
  return {
    id:          String(r['id']),
    title:       String(r['title']),
    description: String(r['description']),
    tags:        String(r['tags']),
    linkUrl:     String(r['link_url']),
    boardName:   String(r['board_name']),
    designFile:  r['design_file'] ? String(r['design_file']) : null,
    priority:    Number(r['priority']) || 50,
  }
}

export async function markPinPosted(workspaceId: string, pinQueueId: string, externalUrl: string): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    UPDATE pinterest_pin_queue
    SET status = 'posted', posted_at = ${Date.now()}, external_url = ${externalUrl}
    WHERE workspace_id = ${workspaceId} AND id = ${pinQueueId}
  `)
}

export async function markPinFailed(workspaceId: string, pinQueueId: string, reason: string): Promise<void> {
  await ensureTable()
  await db.execute(sql`
    UPDATE pinterest_pin_queue
    SET status = 'failed', notes = ${reason.slice(0, 500)}
    WHERE workspace_id = ${workspaceId} AND id = ${pinQueueId}
  `)
}

export interface PinStats {
  queued:           number
  postedTotal:      number
  postedToday:      number
  failedTotal:      number
  remainingToday:   number
}

export async function pinStats(workspaceId: string): Promise<PinStats> {
  await ensureTable()
  const cutoff = Date.now() - DAY_MS
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'posted')::int AS posted_total,
      COUNT(*) FILTER (WHERE status = 'posted' AND posted_at >= ${cutoff})::int AS posted_today,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_total
    FROM pinterest_pin_queue
    WHERE workspace_id = ${workspaceId}
  `)
  const r = (rows as unknown as Array<Record<string, number>>)[0] ?? { queued: 0, posted_total: 0, posted_today: 0, failed_total: 0 }
  return {
    queued:         Number(r['queued']) || 0,
    postedTotal:    Number(r['posted_total']) || 0,
    postedToday:    Number(r['posted_today']) || 0,
    failedTotal:    Number(r['failed_total']) || 0,
    remainingToday: Math.max(0, SAFE_PIN_VELOCITY - (Number(r['posted_today']) || 0)),
  }
}

/**
 * Bulk-load the 25 pins from R360-pinterest-pins.md. Operator calls this
 * ONCE to seed the queue. Idempotent on (workspace, title) — re-running
 * does not dupe.
 */
export interface BulkLoadInput {
  workspaceId:  string
  pins: Array<{
    title:        string
    description:  string
    tags:         string[]
    linkUrl:      string
    boardName?:   string
    designFile?:  string
    priority?:    number
  }>
}

export async function bulkLoadPins(input: BulkLoadInput): Promise<{ ok: true; inserted: number; skipped: number }> {
  await ensureTable()
  let inserted = 0, skipped = 0
  for (const p of input.pins) {
    const existsRows = await db.execute(sql`
      SELECT 1 FROM pinterest_pin_queue
      WHERE workspace_id = ${input.workspaceId} AND title = ${p.title.slice(0, 100)}
      LIMIT 1
    `)
    if (Array.isArray(existsRows) && existsRows.length > 0) { skipped++; continue }
    await enqueuePin({
      workspaceId:  input.workspaceId,
      title:        p.title,
      description:  p.description,
      tags:         p.tags,
      linkUrl:      p.linkUrl,
      boardName:    p.boardName ?? 'Vintage Botanical Prints | CYZOR CREATIONS',
      ...(p.designFile ? { designFile: p.designFile } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
    })
    inserted++
  }
  return { ok: true, inserted, skipped }
}
