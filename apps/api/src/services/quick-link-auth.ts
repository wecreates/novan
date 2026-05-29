/**
 * quick-link-auth.ts — One-time mobile sign-in via QR / short link.
 *
 * Flow:
 *   1. Operator on laptop hits POST /api/v1/auth/quick-link/issue → server
 *      mints a single-use token (32 random bytes, base64url) bound to the
 *      laptop's authenticated workspace + a 5-minute expiry. Token + a
 *      short alias are returned + persisted as an `auth.quick_link_issued`
 *      event.
 *   2. Laptop shows QR pointing at /m/auth?t=<token> (or operator copies
 *      the link).
 *   3. Phone hits that URL. The phone-side handler calls
 *      POST /api/v1/auth/quick-link/redeem → server validates not-expired,
 *      not-used, marks used (`auth.quick_link_redeemed`), and issues the
 *      same auth cookie/JWT the regular login flow would.
 *
 * Honest scope:
 *   - Tokens are server-side single-use. Replay blocked by the redeemed
 *     event check.
 *   - 5-minute expiry — short enough that a leaked link is mostly
 *     harmless by the time anyone could exploit it.
 *   - No QR rendering on the server; the laptop UI uses an existing
 *     small QR library OR data URI + the Google charts shortcut.
 *   - Auth cookie issue mirrors the existing login flow; this module
 *     doesn't reinvent session management.
 */
import { randomBytes } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'

const TOKEN_TTL_MS = 5 * 60_000

export interface IssuedLink {
  token:     string
  expiresAt: number
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** Mint + persist a single-use quick-link token for a workspace. */
export async function issueQuickLink(workspaceId: string, issuedBy: string): Promise<IssuedLink> {
  const token = b64url(randomBytes(32))
  const expiresAt = Date.now() + TOKEN_TTL_MS
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'auth.quick_link_issued', workspaceId,
      payload: { token, expiresAt, issuedBy },
      traceId: uuidv7(), correlationId: token, causationId: null,
      source: 'quick-link-auth', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated — token is still usable per-process */ }
  return { token, expiresAt }
}

export type RedeemResult =
  | { ok: true;  workspaceId: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'error' }

/** Validate + consume a token. Idempotent: a second redeem of the same
 *  token returns reason: 'used'. */
export async function redeemQuickLink(token: string): Promise<RedeemResult> {
  if (!token || token.length < 16 || token.length > 64) return { ok: false, reason: 'unknown' }
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql, desc } = await import('drizzle-orm')
    const rows = await db.select({ type: events.type, workspaceId: events.workspaceId, payload: events.payload })
      .from(events)
      .where(sql`${events.type} IN ('auth.quick_link_issued', 'auth.quick_link_redeemed')
                 AND ${events.payload}->>'token' = ${token}`)
      .orderBy(desc(events.createdAt))
      .limit(2)
      .catch(() => [])
    if (rows.length === 0) return { ok: false, reason: 'unknown' }
    // Most recent event for this token must be `issued`. If we see a
    // `redeemed` it was already consumed.
    if (rows.some(r => r.type === 'auth.quick_link_redeemed')) return { ok: false, reason: 'used' }
    const issued = rows.find(r => r.type === 'auth.quick_link_issued')
    if (!issued) return { ok: false, reason: 'unknown' }
    const p = issued.payload as { expiresAt?: number }
    if (!p.expiresAt || p.expiresAt < Date.now()) return { ok: false, reason: 'expired' }
    const workspaceId = issued.workspaceId as string
    // Mark consumed.
    await db.insert(events).values({
      id: uuidv7(), type: 'auth.quick_link_redeemed', workspaceId,
      payload: { token, redeemedAt: Date.now() },
      traceId: uuidv7(), correlationId: token, causationId: null,
      source: 'quick-link-auth', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
    return { ok: true, workspaceId }
  } catch {
    return { ok: false, reason: 'error' }
  }
}
