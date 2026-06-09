/**
 * R377 — Listing template outcome tracker.
 *
 * Closes the feedback loop on listing copy:
 *   1. Listing-rotator picks (title_idx, desc_idx) for a given (platform, niche)
 *   2. Attribution stored on upload_queue.notes (JSON suffix)
 *   3. When mark_uploaded lands the external_url, we link it to attribution
 *   4. When a sale matches that external_url, recordTemplateOutcome boosts the
 *      win-rate of that (platform, niche, title_idx, desc_idx) tuple
 *   5. Next listing generation prefers the highest-win-rate variant
 *
 * Over many uploads + sales, listing copy converges on what converts.
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS listing_template_outcomes (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      platform        TEXT NOT NULL,
      niche           TEXT NOT NULL,
      title_idx       INTEGER NOT NULL,
      desc_idx        INTEGER NOT NULL DEFAULT 0,
      uploads         INTEGER NOT NULL DEFAULT 0,
      views           INTEGER NOT NULL DEFAULT 0,
      sales           INTEGER NOT NULL DEFAULT 0,
      revenue_usd     NUMERIC NOT NULL DEFAULT 0,
      last_updated_at BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS listing_template_outcomes_unique_idx
    ON listing_template_outcomes (workspace_id, platform, niche, title_idx, desc_idx)
  `).catch(() => {})
}

export interface RecordUploadInput {
  workspaceId: string
  platform:    string
  niche:       string
  titleIdx:    number
  descIdx?:    number
}

export async function recordTemplateUpload(input: RecordUploadInput): Promise<void> {
  await ensureTable()
  const descIdx = input.descIdx ?? 0
  // Upsert: insert or increment uploads
  await db.execute(sql`
    INSERT INTO listing_template_outcomes
      (id, workspace_id, platform, niche, title_idx, desc_idx, uploads, last_updated_at)
    VALUES
      (${uuidv7()}, ${input.workspaceId}, ${input.platform}, ${input.niche}, ${input.titleIdx}, ${descIdx}, 1, ${Date.now()})
    ON CONFLICT (workspace_id, platform, niche, title_idx, desc_idx)
    DO UPDATE SET uploads = listing_template_outcomes.uploads + 1, last_updated_at = ${Date.now()}
  `).catch(() => {/* best-effort */})
}

export interface RecordSaleInput {
  workspaceId: string
  platform:    string
  niche:       string
  titleIdx:    number
  descIdx?:    number
  revenueUsd:  number
}

export async function recordTemplateSale(input: RecordSaleInput): Promise<void> {
  await ensureTable()
  const descIdx = input.descIdx ?? 0
  await db.execute(sql`
    UPDATE listing_template_outcomes
    SET sales = sales + 1, revenue_usd = revenue_usd + ${input.revenueUsd}, last_updated_at = ${Date.now()}
    WHERE workspace_id = ${input.workspaceId} AND platform = ${input.platform} AND niche = ${input.niche}
      AND title_idx = ${input.titleIdx} AND desc_idx = ${descIdx}
  `).catch(() => {/* best-effort */})
}

export interface TemplateRanking {
  platform:    string
  niche:       string
  titleIdx:    number
  descIdx:     number
  uploads:     number
  sales:       number
  revenueUsd:  number
  conversionRate: number       // sales / uploads (Laplace smoothing)
  revenuePerUpload: number     // revenue_usd / uploads
}

/**
 * Returns the highest-converting (titleIdx, descIdx) for a (platform, niche).
 * Uses Laplace smoothing so a 0-upload variant doesn't beat a 100-upload winner.
 * Falls back to titleIdx=0, descIdx=0 if no data.
 */
export async function bestTemplateFor(workspaceId: string, platform: string, niche: string): Promise<{ titleIdx: number; descIdx: number; basedOn: string }> {
  await ensureTable()
  const rows = await db.execute(sql`
    SELECT title_idx, desc_idx, uploads, sales, revenue_usd,
           (sales + 1.0)::numeric / (uploads + 2.0) AS smoothed_conversion
    FROM listing_template_outcomes
    WHERE workspace_id = ${workspaceId} AND platform = ${platform} AND niche = ${niche}
    ORDER BY smoothed_conversion DESC, uploads DESC
    LIMIT 1
  `).catch(() => [] as unknown[])
  const r = (rows as Array<{ title_idx: number; desc_idx: number; uploads: number; sales: number }>)[0]
  if (!r) return { titleIdx: 0, descIdx: 0, basedOn: 'no_data_fallback' }
  return {
    titleIdx: Number(r.title_idx) || 0,
    descIdx:  Number(r.desc_idx)  || 0,
    basedOn:  `${r.sales} sales / ${r.uploads} uploads`,
  }
}

export async function getRankings(workspaceId: string, platform?: string, niche?: string): Promise<TemplateRanking[]> {
  await ensureTable()
  const rows = platform && niche
    ? await db.execute(sql`
        SELECT platform, niche, title_idx, desc_idx, uploads, sales, revenue_usd
        FROM listing_template_outcomes
        WHERE workspace_id = ${workspaceId} AND platform = ${platform} AND niche = ${niche}
        ORDER BY (sales + 1.0) / (uploads + 2.0) DESC, uploads DESC
      `)
    : await db.execute(sql`
        SELECT platform, niche, title_idx, desc_idx, uploads, sales, revenue_usd
        FROM listing_template_outcomes
        WHERE workspace_id = ${workspaceId}
        ORDER BY (sales + 1.0) / (uploads + 2.0) DESC, uploads DESC
        LIMIT 100
      `)
  return (rows as Array<Record<string, unknown>>).map(r => {
    const uploads = Number(r['uploads']) || 0
    const sales   = Number(r['sales']) || 0
    const revenue = Number(r['revenue_usd']) || 0
    return {
      platform: String(r['platform']),
      niche:    String(r['niche']),
      titleIdx: Number(r['title_idx']) || 0,
      descIdx:  Number(r['desc_idx'])  || 0,
      uploads, sales,
      revenueUsd: Math.round(revenue * 100) / 100,
      conversionRate:    uploads > 0 ? sales / uploads : 0,
      revenuePerUpload:  uploads > 0 ? Math.round((revenue / uploads) * 100) / 100 : 0,
    }
  })
}
