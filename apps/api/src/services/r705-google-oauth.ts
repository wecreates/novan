/**
 * R705 — Google OAuth + Gmail + Calendar for the operator's real accounts.
 *
 * One-time consent → refresh token stored → agent can read/send mail and
 * read/create calendar events. Single-user: one connection per workspace.
 *
 * Setup the operator does (once):
 *   1. Tailscale admin → DNS → enable HTTPS Certificates (gives us a cert).
 *   2. Google Cloud Console → create OAuth 2.0 Client (Web application),
 *      add redirect URI = https://novan.<tailnet>.ts.net/auth/google/callback
 *      (or whatever GOOGLE_REDIRECT_URI is set to).
 *   3. Set env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.
 *   4. Visit /auth/google?token=<ops> and click through consent.
 *
 * Scopes requested: gmail.modify (read+send+labels) + calendar (read+write).
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ')

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r705_google_tokens (
        workspace_id   TEXT PRIMARY KEY,
        email          TEXT,
        access_token   TEXT,
        refresh_token  TEXT,
        expires_at     TIMESTAMPTZ,
        scope          TEXT,
        connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r705_oauth_state (
        state         TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

function cfg(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env['GOOGLE_CLIENT_ID']
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET']
  const redirectUri = process.env['GOOGLE_REDIRECT_URI']
  if (!clientId || !clientSecret || !redirectUri) return null
  return { clientId, clientSecret, redirectUri }
}

export async function buildAuthUrl(workspaceId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  await ensureDdl()
  const c = cfg()
  if (!c) return { ok: false, error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI not set' }
  const state = crypto.randomBytes(16).toString('hex')
  try { await db.execute(sql`INSERT INTO r705_oauth_state (state, workspace_id) VALUES (${state}, ${workspaceId})`) } catch { /* tolerated */ }
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  return { ok: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` }
}

export async function handleCallback(code: string, state: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  await ensureDdl()
  const c = cfg()
  if (!c) return { ok: false, error: 'google oauth not configured' }
  // Resolve state → workspace
  let workspaceId = 'default'
  try {
    const rows = await db.execute(sql`SELECT workspace_id FROM r705_oauth_state WHERE state = ${state} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { ok: false, error: 'invalid or expired state' }
    workspaceId = String(r['workspace_id'])
    await db.execute(sql`DELETE FROM r705_oauth_state WHERE state = ${state}`).catch(() => {})
  } catch { return { ok: false, error: 'state lookup failed' } }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: c.clientId, client_secret: c.clientSecret,
        redirect_uri: c.redirectUri, grant_type: 'authorization_code',
      }).toString(),
    })
    if (!res.ok) return { ok: false, error: `token exchange ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}` }
    const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string }
    if (!j.access_token) return { ok: false, error: 'no access_token' }
    // Decode email from id_token (no verification needed — we just got it from Google)
    let email = ''
    if (j.id_token) {
      try { const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1]!, 'base64url').toString()); email = payload.email ?? '' } catch { /* ignore */ }
    }
    const expiresAt = new Date(Date.now() + (j.expires_in ?? 3600) * 1000)
    await db.execute(sql`
      INSERT INTO r705_google_tokens (workspace_id, email, access_token, refresh_token, expires_at, scope)
      VALUES (${workspaceId}, ${email}, ${j.access_token}, ${j.refresh_token ?? null}, ${expiresAt.toISOString()}, ${j.scope ?? SCOPES})
      ON CONFLICT (workspace_id) DO UPDATE SET
        email = COALESCE(EXCLUDED.email, r705_google_tokens.email),
        access_token = EXCLUDED.access_token,
        refresh_token = COALESCE(EXCLUDED.refresh_token, r705_google_tokens.refresh_token),
        expires_at = EXCLUDED.expires_at,
        scope = EXCLUDED.scope,
        updated_at = now()
    `)
    return { ok: true, email }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

/** Returns a valid access token, refreshing if expired. */
export async function getAccessToken(workspaceId: string): Promise<{ ok: boolean; token?: string; email?: string; error?: string }> {
  await ensureDdl()
  const c = cfg()
  if (!c) return { ok: false, error: 'google oauth not configured' }
  try {
    const rows = await db.execute(sql`SELECT access_token, refresh_token, expires_at, email FROM r705_google_tokens WHERE workspace_id = ${workspaceId} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { ok: false, error: 'not connected — visit /auth/google to authorize' }
    const exp = r['expires_at'] ? new Date(String(r['expires_at'])).getTime() : 0
    if (exp > Date.now() + 60_000) {
      return { ok: true, token: String(r['access_token']), email: r['email'] ? String(r['email']) : '' }
    }
    // Refresh
    const refreshToken = r['refresh_token'] ? String(r['refresh_token']) : ''
    if (!refreshToken) return { ok: false, error: 'token expired and no refresh_token; re-authorize' }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId, client_secret: c.clientSecret,
        refresh_token: refreshToken, grant_type: 'refresh_token',
      }).toString(),
    })
    if (!res.ok) return { ok: false, error: `refresh ${res.status}` }
    const j = await res.json() as { access_token?: string; expires_in?: number }
    if (!j.access_token) return { ok: false, error: 'refresh returned no token' }
    const newExp = new Date(Date.now() + (j.expires_in ?? 3600) * 1000)
    await db.execute(sql`UPDATE r705_google_tokens SET access_token = ${j.access_token}, expires_at = ${newExp.toISOString()}, updated_at = now() WHERE workspace_id = ${workspaceId}`)
    return { ok: true, token: j.access_token, email: r['email'] ? String(r['email']) : '' }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function getConnectionStatus(workspaceId: string): Promise<{ connected: boolean; email?: string; scope?: string; connectedAt?: string }> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`SELECT email, scope, connected_at FROM r705_google_tokens WHERE workspace_id = ${workspaceId} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { connected: false }
    return { connected: true, email: r['email'] ? String(r['email']) : '', scope: r['scope'] ? String(r['scope']) : '', connectedAt: r['connected_at'] ? String(r['connected_at']) : '' }
  } catch { return { connected: false } }
}

export async function disconnect(workspaceId: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try { await db.execute(sql`DELETE FROM r705_google_tokens WHERE workspace_id = ${workspaceId}`); return { ok: true } } catch { return { ok: false } }
}
