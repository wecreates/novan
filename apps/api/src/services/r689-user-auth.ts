/**
 * R689 — End-user authentication.
 *
 * Lightweight email/password signup + bearer-token sessions for non-admin
 * users. Each user lives in their own workspace (workspaceId = `usr_<id>`)
 * so existing per-workspace ops scope cleanly.
 *
 * - scrypt password hashing (no external deps)
 * - opaque session tokens (32 bytes hex), 30-day TTL
 * - rate-limited via R683 (login/signup share the agentStream bucket)
 *
 * NOT for the operator's admin paths — those still use ADMIN_LOOPBACK_TOKEN.
 */
import crypto from 'crypto'
import { promisify } from 'util'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const scrypt = promisify(crypto.scrypt) as (pw: string | Buffer, salt: Buffer, keylen: number) => Promise<Buffer>

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000  // 30 days
const SCRYPT_KEYLEN = 64

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r689_users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        pw_hash       TEXT NOT NULL,
        pw_salt       TEXT NOT NULL,
        workspace_id  TEXT NOT NULL UNIQUE,
        display_name  TEXT,
        verified      BOOLEAN NOT NULL DEFAULT false,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r689_sessions (
        token         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r689_sessions_user_idx ON r689_sessions (user_id, expires_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

function hashPassword(pw: string, salt: Buffer): Promise<Buffer> {
  return scrypt(pw, salt, SCRYPT_KEYLEN)
}
function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254
}

export interface SignupInput { email: string; password: string; displayName?: string }
export interface LoginInput  { email: string; password: string }

export interface AuthResult { ok: boolean; userId?: string; workspaceId?: string; sessionToken?: string; expiresAt?: number; error?: string }

export async function signup(input: SignupInput): Promise<AuthResult> {
  await ensureDdl()
  if (!isValidEmail(input.email)) return { ok: false, error: 'invalid email' }
  if (!input.password || input.password.length < 8) return { ok: false, error: 'password must be ≥8 chars' }
  const email = input.email.toLowerCase().trim()

  const salt = crypto.randomBytes(16)
  const hash = await hashPassword(input.password, salt)
  const userId = `usr_${crypto.randomBytes(8).toString('hex')}`
  const workspaceId = userId  // 1:1 user→workspace

  try {
    await db.execute(sql`
      INSERT INTO r689_users (id, email, pw_hash, pw_salt, workspace_id, display_name)
      VALUES (${userId}, ${email}, ${hash.toString('hex')}, ${salt.toString('hex')}, ${workspaceId}, ${input.displayName ?? null})
    `)
  } catch (e) {
    if ((e as Error).message?.includes('duplicate') || (e as Error).message?.includes('unique')) return { ok: false, error: 'email already registered' }
    return { ok: false, error: (e as Error).message }
  }

  return openSession(userId, workspaceId)
}

export async function login(input: LoginInput): Promise<AuthResult> {
  await ensureDdl()
  if (!isValidEmail(input.email) || !input.password) return { ok: false, error: 'invalid credentials' }
  const email = input.email.toLowerCase().trim()

  try {
    const rows = await db.execute(sql`SELECT id, pw_hash, pw_salt, workspace_id FROM r689_users WHERE email = ${email} LIMIT 1`)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { ok: false, error: 'invalid credentials' }
    const salt = Buffer.from(String(r['pw_salt']), 'hex')
    const expected = Buffer.from(String(r['pw_hash']), 'hex')
    const actual = await hashPassword(input.password, salt)
    if (!constantTimeEqual(actual, expected)) return { ok: false, error: 'invalid credentials' }
    return openSession(String(r['id']), String(r['workspace_id']))
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

async function openSession(userId: string, workspaceId: string): Promise<AuthResult> {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  try {
    await db.execute(sql`INSERT INTO r689_sessions (token, user_id, expires_at) VALUES (${token}, ${userId}, ${expiresAt.toISOString()})`)
  } catch (e) { return { ok: false, error: (e as Error).message } }
  return { ok: true, userId, workspaceId, sessionToken: token, expiresAt: expiresAt.getTime() }
}

/** Resolve a bearer/session token → user + workspace. Sliding window: refresh last_used_at. */
export async function resolveSession(token: string): Promise<{ ok: boolean; userId?: string; workspaceId?: string; error?: string }> {
  await ensureDdl()
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, error: 'invalid token' }
  try {
    const rows = await db.execute(sql`
      SELECT s.user_id, s.expires_at, u.workspace_id
      FROM r689_sessions s JOIN r689_users u ON u.id = s.user_id
      WHERE s.token = ${token} LIMIT 1
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { ok: false, error: 'session not found' }
    if (new Date(String(r['expires_at'])).getTime() < Date.now()) return { ok: false, error: 'session expired' }
    // sliding window
    void db.execute(sql`UPDATE r689_sessions SET last_used_at = now() WHERE token = ${token}`).catch(() => {})
    return { ok: true, userId: String(r['user_id']), workspaceId: String(r['workspace_id']) }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function logout(token: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try { await db.execute(sql`DELETE FROM r689_sessions WHERE token = ${token}`) } catch { return { ok: false } }
  return { ok: true }
}

export async function userInfo(userId: string): Promise<Record<string, unknown> | null> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`SELECT id, email, workspace_id, display_name, verified, created_at FROM r689_users WHERE id = ${userId} LIMIT 1`)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0] ?? null
  } catch { return null }
}

export async function listUsers(limit = 50): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, email, workspace_id, display_name, verified, created_at
      FROM r689_users ORDER BY created_at DESC LIMIT ${limit}
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}
