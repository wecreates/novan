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
  redactedAudience:   number       // R541 — audience_captures + leads
  redactedBios:       number       // R541 — bio_subscribers if present
}

export async function gdprDeleteEmail(workspaceId: string, email: string): Promise<GdprDeleteResult> {
  if (!email || !email.includes('@')) return { ok: false, redactedRevenue: 0, redactedEvents: 0, redactedBuyerOptin: 0, redactedAudience: 0, redactedBios: 0 }
  const normalized = email.trim().toLowerCase()
  let redactedRevenue = 0, redactedEvents = 0, redactedBuyerOptin = 0
  let redactedAudience = 0, redactedBios = 0
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
  // R541 — also wipe owned-audience captures (R162 lead magnets). These hold
  // raw email + name so GDPR mandates erasure.
  try {
    const r4 = await db.execute(sql`
      DELETE FROM audience_captures
      WHERE workspace_id = ${workspaceId} AND lower(email) = ${normalized}
      RETURNING 1
    `).catch(() => null)
    if (r4) {
      const a4 = (r4 as unknown as { rows?: unknown[] } | unknown[])
      redactedAudience = (Array.isArray(a4) ? a4 : (a4.rows ?? [])).length
    }
  } catch { /* table may not exist */ }
  // R541 — bio_subscribers captures public-bio opt-ins; same scope as buyer_emails.
  try {
    const r5 = await db.execute(sql`
      DELETE FROM bio_subscribers
      WHERE workspace_id = ${workspaceId} AND lower(email) = ${normalized}
      RETURNING 1
    `).catch(() => null)
    if (r5) {
      const a5 = (r5 as unknown as { rows?: unknown[] } | unknown[])
      redactedBios = (Array.isArray(a5) ? a5 : (a5.rows ?? [])).length
    }
  } catch { /* table may not exist */ }
  // R564 — emit audit event so GDPR action is forensically traceable.
  // Stores hash(email) not the email itself (we just deleted it!).
  try {
    const { createHash } = await import('node:crypto')
    const { v7: uuidv7 } = await import('uuid')
    const emailHash = createHash('sha256').update(normalized).digest('hex').slice(0, 16)
    await db.execute(sql`
      INSERT INTO events (id, type, workspace_id, payload, trace_id, correlation_id, source, version, created_at)
      VALUES (${uuidv7()}, 'gdpr.deletion_completed', ${workspaceId},
        ${JSON.stringify({ emailHash, redactedRevenue, redactedEvents, redactedBuyerOptin, redactedAudience, redactedBios })}::jsonb,
        ${uuidv7()}, ${uuidv7()}, 'r515-gdpr-delete', 1, ${Date.now()})
    `).catch(() => {/* tolerated */})
  } catch { /* tolerated */ }
  return { ok: true, redactedRevenue, redactedEvents, redactedBuyerOptin, redactedAudience, redactedBios }
}
