/**
 * R146.349 — Per-Platform Upload Queue
 *
 * Manages the list of designs queued for manual operator upload per
 * platform, enforces safe daily velocity, tracks status, and prevents
 * re-uploading the same design to the same platform.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { v7 as uuidv7 } from 'uuid'
import type { Platform } from './r349-listing-content-rotator.js'

export type QueueStatus = 'queued' | 'uploaded' | 'skipped' | 'failed'

export interface QueueItem {
  id:            string
  workspaceId:   string
  designId:      string
  platform:      Platform
  status:        QueueStatus
  priority:      number
  title:         string
  description:   string
  tags:          string                 // comma-separated
  priceUsd:      number | null
  category:      string | null
  queuedAt:      number
  uploadedAt:    number | null
  externalUrl:   string | null
  notes:         string | null
}

/**
 * Safe per-platform daily upload velocity. Operator can upload these
 * volumes/day without triggering bot/spam heuristics on any platform.
 * Numbers from POD community benchmarks for new sellers.
 */
export const SAFE_DAILY_VELOCITY: Record<Platform, number> = {
  gumroad:           20,    // creator marketplaces are bulk-friendly
  inprnt:            10,    // premium platform, modest pace looks natural
  fine_art_america:  15,
  redbubble:         20,    // RB explicitly allows bulk via CSV
  zazzle:            15,
  spreadshirt:       15,
  teepublic:         20,
  tiktok_shop:       8,     // TikTok is the strictest fraud surface
  etsy:              10,    // Etsy is strict on new sellers; ramp slowly
  displate:          5,     // Displate is premium curated; slow pace looks natural
  threadless:        10,    // Threadless apparel platform
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  workspaceId:  string
  designId:     string
  platform:     Platform
  title:        string
  description:  string
  tags:         string[]
  priceUsd?:    number
  category?:    string
  priority?:    number
  notes?:       string
}

export async function enqueue(input: EnqueueInput): Promise<{ ok: boolean; id?: string; reason?: string }> {
  try {
    const id = uuidv7()
    await db.execute(sql`
      INSERT INTO design_upload_queue
        (id, workspace_id, design_id, platform, status, priority, title, description, tags, price_usd, category, queued_at, notes)
      VALUES
        (${id}, ${input.workspaceId}, ${input.designId}, ${input.platform}, 'queued',
         ${input.priority ?? 50}, ${input.title}, ${input.description},
         ${input.tags.join(',')}, ${input.priceUsd ?? null}, ${input.category ?? null},
         ${Date.now()}, ${input.notes ?? null})
      ON CONFLICT (workspace_id, design_id, platform) DO NOTHING
    `)
    return { ok: true, id }
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 200) }
  }
}

// ─── Next-for-platform (today's safe-velocity slice) ────────────────────────

export async function nextForPlatform(opts: {
  workspaceId: string
  platform:    Platform
  limit?:      number             // overrides SAFE_DAILY_VELOCITY[platform]
}): Promise<QueueItem[]> {
  const cap = opts.limit ?? SAFE_DAILY_VELOCITY[opts.platform]
  try {
    const rows = await db.execute(sql`
      SELECT q.id, q.workspace_id, q.design_id, q.platform, q.status, q.priority,
             q.title, q.description, q.tags, q.price_usd, q.category,
             q.queued_at, q.uploaded_at, q.external_url, q.notes,
             d.image_url
      FROM design_upload_queue q
      LEFT JOIN design_catalog d ON d.id = q.design_id
      WHERE q.workspace_id = ${opts.workspaceId}
        AND q.platform     = ${opts.platform}
        AND q.status       = 'queued'
      ORDER BY q.priority DESC, q.queued_at ASC
      LIMIT ${cap}
    `)
    return mapRows(rows as unknown as Array<Record<string, unknown>>)
  } catch (e) {
    console.error('[r349-upload-queue] nextForPlatform failed:', (e as Error).message)
    return []
  }
}

// ─── Mark uploaded ──────────────────────────────────────────────────────────

export async function markUploaded(opts: {
  workspaceId:  string
  queueItemId:  string
  externalUrl?: string
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    await db.execute(sql`
      UPDATE design_upload_queue
      SET status = 'uploaded',
          uploaded_at = ${Date.now()},
          external_url = ${opts.externalUrl ?? null}
      WHERE workspace_id = ${opts.workspaceId} AND id = ${opts.queueItemId}
    `)
    // Bump is_live_count on the design
    await db.execute(sql`
      UPDATE design_catalog d
      SET is_live_count = (
        SELECT COUNT(*) FROM design_upload_queue q
        WHERE q.workspace_id = ${opts.workspaceId}
          AND q.design_id = d.id
          AND q.status = 'uploaded'
      )
      WHERE d.workspace_id = ${opts.workspaceId}
        AND d.id = (
          SELECT design_id FROM design_upload_queue WHERE id = ${opts.queueItemId}
        )
    `)
    // R393 — auto-enqueue Pinterest pins for newly-live listings.
    // Only fires for gumroad (the only platform whose URL maps cleanly to a pin link target).
    if (opts.externalUrl) {
      try {
        const rows = await db.execute(sql`
          SELECT platform, design_id, title FROM design_upload_queue WHERE id = ${opts.queueItemId} LIMIT 1
        `)
        const r = (rows as Array<{ platform: string; design_id: string; title: string }>)[0]
        if (r && r.platform === 'gumroad') {
          const { autoPinFromListing } = await import('./r393-auto-pin-from-upload.js')
          void autoPinFromListing({
            workspaceId: opts.workspaceId,
            designId:    r.design_id,
            title:       r.title,
            externalUrl: opts.externalUrl,
          })
        }
      } catch { /* tolerated */ }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 200) }
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface QueueStats {
  platform:      Platform
  queued:        number
  uploadedToday: number
  uploadedTotal: number
  dailyCap:      number
  remainingToday:number
}

export async function statsByPlatform(workspaceId: string): Promise<QueueStats[]> {
  const platforms = Object.keys(SAFE_DAILY_VELOCITY) as Platform[]
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayStartMs = dayStart.getTime()

  const out: QueueStats[] = []
  for (const platform of platforms) {
    try {
      const rows = await db.execute(sql`
        SELECT status, COUNT(*) AS n,
               COUNT(*) FILTER (WHERE status = 'uploaded' AND uploaded_at >= ${dayStartMs}) AS uploaded_today
        FROM design_upload_queue
        WHERE workspace_id = ${workspaceId} AND platform = ${platform}
        GROUP BY status
      `) as unknown as Array<{ status: string; n: number; uploaded_today: number }>
      let queued = 0, uploadedTotal = 0, uploadedToday = 0
      for (const r of rows) {
        if (r.status === 'queued') queued = Number(r.n)
        if (r.status === 'uploaded') { uploadedTotal = Number(r.n); uploadedToday = Number(r.uploaded_today) }
      }
      out.push({
        platform, queued, uploadedToday, uploadedTotal,
        dailyCap: SAFE_DAILY_VELOCITY[platform],
        remainingToday: Math.max(0, SAFE_DAILY_VELOCITY[platform] - uploadedToday),
      })
    } catch { /* skip platform on error */ }
  }
  return out
}

function mapRows(rows: Array<Record<string, unknown>>): QueueItem[] {
  return rows.map(r => ({
    id:          String(r['id']),
    workspaceId: String(r['workspace_id']),
    designId:    String(r['design_id']),
    platform:    String(r['platform']) as Platform,
    status:      String(r['status']) as QueueStatus,
    priority:    Number(r['priority']) || 50,
    title:       String(r['title']),
    description: String(r['description']),
    tags:        String(r['tags']),
    priceUsd:    r['price_usd'] !== null ? Number(r['price_usd']) : null,
    category:    r['category'] !== null ? String(r['category']) : null,
    queuedAt:    Number(r['queued_at']) || 0,
    uploadedAt:  r['uploaded_at'] !== null ? Number(r['uploaded_at']) : null,
    externalUrl: r['external_url'] !== null ? String(r['external_url']) : null,
    notes:       r['notes'] !== null ? String(r['notes']) : null,
  }))
}
