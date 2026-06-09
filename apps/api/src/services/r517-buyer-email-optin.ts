/**
 * R517 — Buyer-email opt-in capture.
 *
 * When a Gumroad sale webhook includes the buyer email AND they ticked the
 * "OK to send updates" box (Gumroad sends `can_contact: true`), we stash it
 * in buyer_emails so operator can later mail-merge new-design announcements.
 *
 * Strict opt-in only. Never stores emails without explicit consent.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS buyer_emails (
      workspace_id  TEXT NOT NULL,
      email         TEXT NOT NULL,
      source        TEXT NOT NULL,
      first_seen_at BIGINT NOT NULL,
      last_seen_at  BIGINT NOT NULL,
      sale_count    INT NOT NULL DEFAULT 1,
      PRIMARY KEY (workspace_id, email)
    )
  `).catch(() => {})
}

export async function captureOptIn(workspaceId: string, email: string, source: string, canContact: boolean): Promise<{ stored: boolean; reason?: string }> {
  if (!canContact) return { stored: false, reason: 'no consent' }
  if (!email || !email.includes('@') || email.length > 320) return { stored: false, reason: 'invalid email' }
  await ensureTable()
  const normalized = email.trim().toLowerCase()
  const now = Date.now()
  try {
    await db.execute(sql`
      INSERT INTO buyer_emails (workspace_id, email, source, first_seen_at, last_seen_at, sale_count)
      VALUES (${workspaceId}, ${normalized}, ${source}, ${now}, ${now}, 1)
      ON CONFLICT (workspace_id, email) DO UPDATE
        SET last_seen_at = EXCLUDED.last_seen_at,
            sale_count = buyer_emails.sale_count + 1
    `)
    return { stored: true }
  } catch (e) {
    return { stored: false, reason: (e as Error).message.slice(0, 80) }
  }
}

export async function listOptIns(workspaceId: string, limit = 500): Promise<Array<{ email: string; source: string; saleCount: number; lastSeenAt: number }>> {
  await ensureTable()
  try {
    const r = await db.execute(sql`
      SELECT email, source, sale_count, last_seen_at FROM buyer_emails
      WHERE workspace_id = ${workspaceId}
      ORDER BY last_seen_at DESC LIMIT ${limit}
    `)
    return (r as unknown as Array<{ email: string; source: string; sale_count: number; last_seen_at: number }>).map(x => ({
      email: x.email, source: x.source, saleCount: Number(x.sale_count), lastSeenAt: Number(x.last_seen_at),
    }))
  } catch { return [] }
}

export async function countOptIns(workspaceId: string): Promise<number> {
  await ensureTable()
  try {
    const r = await db.execute(sql`SELECT COUNT(*)::int AS n FROM buyer_emails WHERE workspace_id = ${workspaceId}`)
    return Number((r as unknown as Array<{ n: number }>)[0]?.n ?? 0)
  } catch { return 0 }
}
