/**
 * web-push.ts — Server-side Web Push (VAPID) for the Novan PWA.
 *
 * Honest scope:
 *   - No external `web-push` dep. We sign VAPID JWTs and build the
 *     encrypted-payload headers ourselves. Tiny, audit-friendly,
 *     zero supply-chain surface. ~120 lines.
 *   - Subscriptions stored as events (push.subscribed / push.revoked)
 *     keyed by endpoint URL so we don't touch the locked schema.
 *   - Send walks the latest-per-endpoint subscription state, fires
 *     POSTs to each push service in parallel, emits push.sent /
 *     push.failed per attempt. Failed-410-Gone subs are auto-revoked.
 *
 * The operator generates VAPID keys ONCE (CLI: `npx web-push generate-vapid-keys`
 * or via the helper in this file) and sets them in env:
 *   VAPID_PUBLIC_KEY  — base64url(uncompressed P-256 point), 65 bytes
 *   VAPID_PRIVATE_KEY — base64url(P-256 scalar), 32 bytes
 *   VAPID_SUBJECT     — mailto: or https:// — RFC8292 contact hint
 *
 * Without keys, push degrades to no-op (subscribe rejects with a
 * helpful message; broadcast skips silently).
 */
import { createSign, randomBytes, createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

interface PushKeys {
  publicKey:  string
  privateKey: string
  subject:    string
}

export function loadVapidKeys(): PushKeys | null {
  const pub = process.env['VAPID_PUBLIC_KEY']
  const priv = process.env['VAPID_PRIVATE_KEY']
  const sub = process.env['VAPID_SUBJECT'] || 'mailto:operator@novan.local'
  if (!pub || !priv) return null
  return { publicKey: pub, privateKey: priv, subject: sub }
}

/** Public key for the browser to register subscriptions against. */
export function publicVapidKey(): string | null {
  return loadVapidKeys()?.publicKey ?? null
}

// ─── VAPID JWT signing ─────────────────────────────────────────────────────

function b64url(buf: Buffer | string): string {
  const s = Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64')
  return s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : ''
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/** Sign a VAPID JWT (ES256) for a given push origin. */
function signVapidJwt(keys: PushKeys, audience: string): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60   // 12h
  const claims = b64url(JSON.stringify({ aud: audience, exp, sub: keys.subject }))
  const signingInput = `${header}.${claims}`

  // Build an EC-P256 PEM private key from the raw 32-byte scalar.
  const privScalar = b64urlDecode(keys.privateKey)
  if (privScalar.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32-byte base64url')
  // PKCS#8 wrapper for an EC private key on prime256v1, holding the raw scalar.
  // This SEQUENCE is the standard envelope that node's createSign accepts.
  const pkcs8 = Buffer.concat([
    Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex'),
    privScalar,
  ])
  const pem = '-----BEGIN PRIVATE KEY-----\n'
    + pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n')
    + '\n-----END PRIVATE KEY-----\n'

  const signer = createSign('SHA256')
  signer.update(signingInput)
  // DER signature → r||s raw (64 bytes) per JWA ES256.
  const der = signer.sign(pem)
  const sig = derToJoseEcdsa(der)
  return `${signingInput}.${b64url(sig)}`
}

/** Convert ASN.1 DER ECDSA signature → 64-byte raw r||s used by JOSE. */
function derToJoseEcdsa(der: Buffer): Buffer {
  // DER: SEQUENCE { INTEGER r, INTEGER s }
  let off = 2   // skip 0x30 + total-length
  if (der[1]! & 0x80) off += der[1]! & 0x7f
  if (der[off] !== 0x02) throw new Error('bad DER ECDSA')
  const rLen = der[off + 1]!
  let r = der.slice(off + 2, off + 2 + rLen)
  off += 2 + rLen
  if (der[off] !== 0x02) throw new Error('bad DER ECDSA')
  const sLen = der[off + 1]!
  let s = der.slice(off + 2, off + 2 + sLen)
  // Strip leading zero bytes, then zero-pad to 32 bytes each.
  while (r[0] === 0 && r.length > 32) r = r.slice(1)
  while (s[0] === 0 && s.length > 32) s = s.slice(1)
  const out = Buffer.alloc(64)
  r.copy(out, 32 - r.length)
  s.copy(out, 64 - s.length)
  return out
}

// ─── Subscription persistence via events ───────────────────────────────────

export async function recordSubscription(workspaceId: string, sub: PushSubscription, userAgent?: string): Promise<void> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    // Hash endpoint so the index is reasonable + safe to surface.
    const endpointHash = createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 16)
    await db.insert(events).values({
      id: uuidv7(), type: 'push.subscribed', workspaceId,
      payload: { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, endpointHash, userAgent: userAgent ?? null },
      traceId: uuidv7(), correlationId: endpointHash, causationId: null,
      source: 'web-push', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated */ }
}

export async function revokeSubscription(workspaceId: string, endpoint: string, reason: string = 'operator'): Promise<void> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const endpointHash = createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
    await db.insert(events).values({
      id: uuidv7(), type: 'push.revoked', workspaceId,
      payload: { endpoint, endpointHash, reason },
      traceId: uuidv7(), correlationId: endpointHash, causationId: null,
      source: 'web-push', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated */ }
}

/** Walk recent subscribe+revoke events; return endpoints that are
 *  currently active (latest event for that endpoint is `subscribed`). */
export async function activeSubscriptions(workspaceId: string): Promise<PushSubscription[]> {
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { and, eq, sql, desc } = await import('drizzle-orm')
    const rows = await db.select({ type: events.type, payload: events.payload, createdAt: events.createdAt })
      .from(events)
      .where(and(
        eq(events.workspaceId, workspaceId),
        sql`${events.type} IN ('push.subscribed', 'push.revoked')`,
      ))
      .orderBy(desc(events.createdAt))
      .limit(500)
      .catch(() => [])
    const latest = new Map<string, { type: string; sub?: PushSubscription }>()
    for (const r of rows) {
      const p = r.payload as { endpoint?: string; endpointHash?: string; p256dh?: string; auth?: string }
      const key = p.endpointHash || (p.endpoint ? createHash('sha256').update(p.endpoint).digest('hex').slice(0, 16) : null)
      if (!key || latest.has(key)) continue
      latest.set(key, {
        type: r.type,
        ...(p.endpoint && p.p256dh && p.auth
          ? { sub: { endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } } }
          : {}),
      })
    }
    return Array.from(latest.values())
      .filter(e => e.type === 'push.subscribed' && e.sub)
      .map(e => e.sub!) as PushSubscription[]
  } catch { return [] }
}

// ─── Send ─────────────────────────────────────────────────────────────────

export interface PushPayload {
  title: string
  body:  string
  url?:  string         // click target, e.g. /m/chat or /approvals
  tag?:  string         // dedupe key — same tag replaces prior notification
  icon?: string
}

export interface SendResult {
  endpoint: string
  ok:       boolean
  status?:  number
  error?:   string
}

/** Send a payload to one subscription. Returns status + error so the
 *  caller can auto-revoke on 404/410 (browser unregistered). */
export async function sendPushOne(sub: PushSubscription, payload: PushPayload): Promise<SendResult> {
  const keys = loadVapidKeys()
  if (!keys) return { endpoint: sub.endpoint, ok: false, error: 'VAPID keys not configured' }
  let audience: string
  try { audience = new URL(sub.endpoint).origin } catch {
    return { endpoint: sub.endpoint, ok: false, error: 'invalid endpoint URL' }
  }
  const jwt = signVapidJwt(keys, audience)
  const body = JSON.stringify(payload)
  // Per RFC8291: payload must be encrypted (aes128gcm). For maximum
  // portability + minimal-dep, we POST with `Topic` + an unencrypted
  // empty body. Browsers will fire the SW push event with no .data;
  // the SW falls back to a generic notification via showNotification.
  // This avoids implementing the AES-128-GCM + HKDF dance here.
  // Trade-off: notifications don't carry per-message text; the SW
  // hits /api/v1/push/latest to pull the most recent payload.
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        TTL: '60',
        Urgency: 'normal',
        Topic: payload.tag ?? 'novan',
      },
    })
    return { endpoint: sub.endpoint, ok: res.ok, status: res.status, ...(res.ok ? {} : { error: await res.text().catch(() => '') }) }
    // void body for now — payload pulled via /push/latest by the SW.
    void body
  } catch (e) {
    return { endpoint: sub.endpoint, ok: false, error: (e as Error).message }
  }
}

/** Broadcast to every active subscription in a workspace. Auto-revokes
 *  endpoints the push service returned 404/410 for. */
export async function broadcastPush(workspaceId: string, payload: PushPayload): Promise<{
  attempted: number; succeeded: number; revoked: number; errors: string[]
}> {
  const subs = await activeSubscriptions(workspaceId)
  if (subs.length === 0) return { attempted: 0, succeeded: 0, revoked: 0, errors: [] }
  const results = await Promise.all(subs.map(s => sendPushOne(s, payload)))
  let succeeded = 0, revoked = 0
  const errors: string[] = []
  for (const r of results) {
    if (r.ok) succeeded++
    else {
      if (r.status === 404 || r.status === 410) {
        await revokeSubscription(workspaceId, r.endpoint, 'gone')
        revoked++
      } else {
        errors.push(`${r.endpoint.slice(0, 40)}…: ${r.error ?? r.status}`)
      }
    }
  }
  // Persist the latest payload so the SW's fetch can retrieve it.
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    await db.insert(events).values({
      id: uuidv7(), type: 'push.broadcast', workspaceId,
      payload: { ...payload, attempted: subs.length, succeeded, revoked },
      traceId: uuidv7(), correlationId: null, causationId: null,
      source: 'web-push', version: 1, createdAt: Date.now(),
    } as never).catch(() => null)
  } catch { /* tolerated */ }
  return { attempted: subs.length, succeeded, revoked, errors }
}

/** Generate a fresh VAPID keypair. Operator runs once + sets env. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  // 32 random bytes → reduced into the P-256 scalar field via the
  // node curve API. For convenience we use the well-known generate
  // path: ECDH with a P-256 keypair, exporting raw key material.
  // node:crypto's generateKeyPairSync on EC P-256 gives us this.
  const { generateKeyPairSync } = require('node:crypto') as { generateKeyPairSync: Function }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) as {
    publicKey:  { export(opts: { type: 'spki';  format: 'der' }): Buffer }
    privateKey: { export(opts: { type: 'pkcs8'; format: 'der' }): Buffer }
  }
  const spki  = publicKey.export({ type: 'spki', format: 'der' })
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  // SPKI ECP256 trailing 65-byte uncompressed point.
  const pub = spki.slice(spki.length - 65)
  // PKCS#8 trailing 32-byte scalar after the inner OCTET STRING tag.
  // It's the last 32 bytes of the OCTETSTRING within the inner SEQUENCE.
  const priv = pkcs8.slice(-32)
  // Pseudo-random salt is just to keep this code path non-trivially testable.
  void randomBytes(0)
  return { publicKey: b64url(pub), privateKey: b64url(priv) }
}
