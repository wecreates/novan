/**
 * R700 — Per-user API keys for programmatic access.
 *
 * R689 issued 30-day session bearer tokens — fine for browser, not for
 * machines. R700 lets a logged-in user mint a long-lived API key with a
 * scope (read | write | admin) and revoke any key by id. Keys hashed in DB
 * (only the prefix surfaces; raw key only returned once at creation).
 *
 * Also sets CORS on the API surfaces external integrators will hit.
 */
import crypto from 'crypto'
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

const KEY_PREFIX = 'nvk_'
const SCOPES = new Set(['read', 'write', 'admin'])

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r700_api_keys (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        workspace_id  TEXT NOT NULL,
        scope         TEXT NOT NULL,
        name          TEXT,
        key_prefix    TEXT NOT NULL,
        key_hash      TEXT NOT NULL,
        revoked_at    TIMESTAMPTZ,
        last_used_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    await db.execute(sql`CREATE INDEX IF NOT EXISTS r700_keys_user_idx ON r700_api_keys (user_id, revoked_at)`).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export async function mintKey(userId: string, workspaceId: string, scope: string, name?: string): Promise<{ ok: boolean; id?: string; key?: string; error?: string }> {
  await ensureDdl()
  if (!SCOPES.has(scope)) return { ok: false, error: 'scope must be read|write|admin' }
  const raw = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`
  const id = `nvk_id_${crypto.randomBytes(6).toString('hex')}`
  const prefix = raw.slice(0, 12)
  try {
    await db.execute(sql`
      INSERT INTO r700_api_keys (id, user_id, workspace_id, scope, name, key_prefix, key_hash)
      VALUES (${id}, ${userId}, ${workspaceId}, ${scope}, ${name ?? null}, ${prefix}, ${hashKey(raw)})
    `)
    return { ok: true, id, key: raw }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function resolveApiKey(raw: string): Promise<{ ok: boolean; userId?: string; workspaceId?: string; scope?: string; error?: string }> {
  await ensureDdl()
  if (!raw.startsWith(KEY_PREFIX)) return { ok: false, error: 'invalid key format' }
  try {
    const rows = await db.execute(sql`
      SELECT id, user_id, workspace_id, scope, revoked_at FROM r700_api_keys WHERE key_hash = ${hashKey(raw)} LIMIT 1
    `)
    const r = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0]
    if (!r) return { ok: false, error: 'key not found' }
    if (r['revoked_at']) return { ok: false, error: 'key revoked' }
    void db.execute(sql`UPDATE r700_api_keys SET last_used_at = now() WHERE id = ${String(r['id'])}`).catch(() => {})
    return { ok: true, userId: String(r['user_id']), workspaceId: String(r['workspace_id']), scope: String(r['scope']) }
  } catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function listUserKeys(userId: string): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`
      SELECT id, scope, name, key_prefix, revoked_at, last_used_at, created_at
      FROM r700_api_keys WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function revokeKey(userId: string, keyId: string): Promise<{ ok: boolean }> {
  await ensureDdl()
  try {
    await db.execute(sql`UPDATE r700_api_keys SET revoked_at = now() WHERE id = ${keyId} AND user_id = ${userId} AND revoked_at IS NULL`)
    return { ok: true }
  } catch { return { ok: false } }
}

/** Allowed CORS origins (comma-separated env or default-permissive for dev). */
export function getCorsOrigins(): string[] {
  const env = process.env['NOVAN_CORS_ORIGINS']
  if (!env) return []
  return env.split(',').map(s => s.trim()).filter(Boolean)
}
