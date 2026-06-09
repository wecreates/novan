/**
 * R515 — GDPR / CCPA buyer-email deletion endpoint.
 *
 * When a buyer requests their email be erased, this finds + redacts every
 * stored copy. Returns count of rows touched. Idempotent.
 *
 * Sources to scrub:
 *   - business_revenue.metadata.email (Gumroad sale email if stored)
 *   - events.payload.email
 *   - buyer_emails (R517 — opt-in capture)
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface GdprDeleteResult {
  ok:                 boolean
  redactedRevenue:    number
  redactedEvents:     number
  redactedBuyerOptin: number
}

export async function gdprDeleteEmail(workspaceId: string, email: string): Promise<GdprDeleteResult> {
  if (!email || !email.includes('@')) return { ok: false, redactedRevenue: 0, redactedEvents: 0, redactedBuyerOptin: 0 }
  const normalized = email.trim().toLowerCase()
  let redactedRevenue = 0, redactedEvents = 0, redactedBuyerOptin = 0
  try {
    // business_revenue: rewrite metadata.email → '<redacted>'
    const r1 = await db.execute(sql`
      UPDATE business_revenue
      SET metadata = jsonb_set(metadata, '{email}', '"<redacted>"'::jsonb, false)
      WHERE workspace_id = ${workspaceId} AND lower(metadata->>'email') = ${normalized}
      RETURNING 1
    `)
    const a1 = (r1 as unknown as { rows?: unknown[] } | unknown[])
    redactedRevenue = (Array.isArray(a1) ? a1 : (a1.rows ?? [])).length
  } catch { /* tolerated */ }
  try {
    const r2 = await db.execute(sql`
      UPDATE events
      SET payload = jsonb_set(payload, '{email}', '"<redacted>"'::jsonb, false)
      WHERE workspace_id = ${workspaceId} AND lower(payload->>'email') = ${normalized}
      RETURNING 1
    `)
    const a2 = (r2 as unknown as { rows?: unknown[] } | unknown[])
    redactedEvents = (Array.isArray(a2) ? a2 : (a2.rows ?? [])).length
  } catch { /* tolerated */ }
  try {
    const r3 = await db.execute(sql`
      DELETE FROM buyer_emails WHERE workspace_id = ${workspaceId} AND lower(email) = ${normalized}
      RETURNING 1
    `).catch(() => null)
    if (r3) {
      const a3 = (r3 as unknown as { rows?: unknown[] } | unknown[])
      redactedBuyerOptin = (Array.isArray(a3) ? a3 : (a3.rows ?? [])).length
    }
  } catch { /* table may not exist */ }
  return { ok: true, redactedRevenue, redactedEvents, redactedBuyerOptin }
}
