/**
 * secrets-vault.ts — Encrypted secret storage with audit trail.
 *
 * Algorithm: AES-256-GCM via node:crypto. Master key from env VAULT_MASTER_KEY
 * (base64, 32 bytes). If missing in dev, derived from process pid+startup
 * timestamp — NOT secure; production MUST set VAULT_MASTER_KEY.
 *
 * Stored format: base64(nonce(12) || tag(16) || ciphertext).
 * Plaintext NEVER returned by list/get endpoints — only via explicit `reveal()`
 * which writes a security audit row.
 */
import * as crypto         from 'node:crypto'
import { db }              from '../db/client.js'
import { secretsVault, securityAudits, events } from '../db/schema.js'
import { eq, desc }        from 'drizzle-orm'
import { v7 as uuidv7 }    from 'uuid'

// ─── Master key ───────────────────────────────────────────────────────────────

function getMasterKey(): Buffer {
  const env = process.env['VAULT_MASTER_KEY']
  if (env) {
    const buf = Buffer.from(env, 'base64')
    if (buf.length !== 32) throw new Error('VAULT_MASTER_KEY must be 32 bytes base64-encoded')
    return buf
  }
  // R146.295 — fail-fast in production. The dev fallback derives the
  // key from `process.pid` + day-of-year, so every restart with a new
  // PID OR every UTC-day rollover changes the key. In production this
  // would silently destroy every previously-stored secret on the next
  // restart, with no log line until a decrypt() call surfaces the
  // mismatch. Force the env var unless explicitly opted into dev mode.
  if (process.env['NODE_ENV'] === 'production' && process.env['ALLOW_DEV_VAULT'] !== '1') {
    throw new Error(
      '[secrets-vault] VAULT_MASTER_KEY required in production. ' +
      'Set the env var (32 random bytes, base64-encoded) or set ' +
      'ALLOW_DEV_VAULT=1 to acknowledge ephemeral key risk.',
    )
  }
  // Dev fallback — derive from pid+startup. NOT production-safe.
  const seed = `dev-vault-${process.pid}-${Math.floor(Date.now() / 86400_000)}`
  return crypto.createHash('sha256').update(seed).digest()
}

const MASTER_KEY = getMasterKey()
const KEY_VERSION = 1  // bump on key rotation

// ─── Encrypt / decrypt ────────────────────────────────────────────────────────

function encrypt(plaintext: string): string {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ct]).toString('base64')
}

function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64')
  if (buf.length < 28) throw new Error('Ciphertext too short')
  const nonce = buf.subarray(0, 12)
  const tag   = buf.subarray(12, 28)
  const ct    = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ─── Redaction for UI ─────────────────────────────────────────────────────────

function redactForUi(plaintext: string): string {
  if (plaintext.length <= 8) return '****'
  return `${plaintext.slice(0, 3)}${'*'.repeat(Math.max(4, plaintext.length - 7))}${plaintext.slice(-4)}`
}

// ─── Audit helper ─────────────────────────────────────────────────────────────

async function audit(
  workspaceId: string, userId: string | null, eventType: string, severity: 'info' | 'warning' | 'critical',
  resource: string, action: string, outcome: 'allowed' | 'denied' | 'recorded',
  context: Record<string, unknown> = {},
) {
  await db.insert(securityAudits).values({
    id: uuidv7(),
    workspaceId, userId,
    eventType, severity, resource, action, outcome,
    context,
    ipAddress: null, userAgent: null,
    immutable: true,
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[secrets-vault]', e.message); return null })

  // Mirror to events table
  await db.insert(events).values({
    id: uuidv7(), type: `security.${eventType}`, workspaceId: workspaceId ?? 'global',
    payload: { ...context, resource, action, outcome, severity },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'secrets-vault', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[secrets-vault]', e.message); return null })
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface StoreSecretInput {
  workspaceId: string
  name:        string
  provider?:   string
  value:       string   // plaintext, ENCRYPTED before persistence
  createdBy?:  string
}

export async function storeSecret(input: StoreSecretInput): Promise<string> {
  if (!input.value || input.value.length === 0) throw new Error('Secret value required')

  const id = uuidv7()
  const now = Date.now()
  const ciphertext = encrypt(input.value)
  const redacted   = redactForUi(input.value)

  await db.insert(secretsVault).values({
    id,
    workspaceId:     input.workspaceId,
    name:            input.name,
    provider:        input.provider ?? null,
    valueCiphertext: ciphertext,
    valueRedacted:   redacted,
    keyVersion:      KEY_VERSION,
    rotatedAt:       null,
    lastAccessedAt:  null,
    accessCount:     0,
    createdBy:       input.createdBy ?? null,
    createdAt:       now,
    updatedAt:       now,
  })

  await audit(input.workspaceId, input.createdBy ?? null, 'secret_accessed', 'info',
    `secret:${input.name}`, 'create', 'recorded', { provider: input.provider })
  return id
}

/**
 * Get plaintext value — REQUIRES caller intent (audit + reason).
 * Every reveal is recorded with severity=warning so abuse is visible.
 */
export async function revealSecret(
  id: string, requestedBy: string, reason: string,
): Promise<string | null> {
  if (!reason || reason.trim().length < 5) {
    throw new Error('Reveal requires a reason (≥5 chars)')
  }

  const rows = await db.select().from(secretsVault).where(eq(secretsVault.id, id)).limit(1)
  const sec = rows[0]
  if (!sec) return null

  let plaintext: string
  try {
    plaintext = decrypt(sec.valueCiphertext)
  } catch (e) {
    await audit(sec.workspaceId, requestedBy, 'secret_accessed', 'critical',
      `secret:${sec.name}`, 'reveal_failed', 'denied', { reason, error: (e as Error).message })
    return null
  }

  const now = Date.now()
  await db.update(secretsVault).set({
    lastAccessedAt: now,
    accessCount:    sec.accessCount + 1,
    updatedAt:      now,
  }).where(eq(secretsVault.id, id))

  await audit(sec.workspaceId, requestedBy, 'secret_accessed', 'warning',
    `secret:${sec.name}`, 'reveal', 'allowed', { reason, provider: sec.provider })

  return plaintext
}

export async function rotateSecret(id: string, newValue: string, rotatedBy: string): Promise<boolean> {
  if (!newValue || newValue.length === 0) return false
  const rows = await db.select().from(secretsVault).where(eq(secretsVault.id, id)).limit(1)
  const sec = rows[0]
  if (!sec) return false

  const now = Date.now()
  await db.update(secretsVault).set({
    valueCiphertext: encrypt(newValue),
    valueRedacted:   redactForUi(newValue),
    keyVersion:      KEY_VERSION,
    rotatedAt:       now,
    updatedAt:       now,
  }).where(eq(secretsVault.id, id))

  await audit(sec.workspaceId, rotatedBy, 'secret_rotated', 'info',
    `secret:${sec.name}`, 'rotate', 'allowed', {})
  return true
}

/** List — returns redacted form ONLY, never plaintext. */
export async function listSecrets(workspaceId: string) {
  const rows = await db.select({
    id:              secretsVault.id,
    name:            secretsVault.name,
    provider:        secretsVault.provider,
    valueRedacted:   secretsVault.valueRedacted,
    keyVersion:      secretsVault.keyVersion,
    rotatedAt:       secretsVault.rotatedAt,
    lastAccessedAt:  secretsVault.lastAccessedAt,
    accessCount:     secretsVault.accessCount,
    createdAt:       secretsVault.createdAt,
    updatedAt:       secretsVault.updatedAt,
  }).from(secretsVault)
    .where(eq(secretsVault.workspaceId, workspaceId))
    .orderBy(desc(secretsVault.updatedAt))
    .limit(200)
  return rows
}

export async function deleteSecret(id: string, deletedBy: string): Promise<boolean> {
  const rows = await db.select().from(secretsVault).where(eq(secretsVault.id, id)).limit(1)
  const sec = rows[0]
  if (!sec) return false
  await db.delete(secretsVault).where(eq(secretsVault.id, id))
  await audit(sec.workspaceId, deletedBy, 'secret_accessed', 'warning',
    `secret:${sec.name}`, 'delete', 'allowed', {})
  return true
}

/**
 * Validate env on startup — confirms VAULT_MASTER_KEY is set in non-dev mode.
 * Throws if production env is unsafe.
 */
export function validateEnvOrThrow(): void {
  const env = process.env['NODE_ENV'] ?? 'development'
  const masterKey = process.env['VAULT_MASTER_KEY']
  if (env === 'production' && !masterKey) {
    throw new Error('SECURITY: VAULT_MASTER_KEY must be set in production (32 bytes base64)')
  }
  if (masterKey) {
    const buf = Buffer.from(masterKey, 'base64')
    if (buf.length !== 32) throw new Error('SECURITY: VAULT_MASTER_KEY must decode to exactly 32 bytes')
  }
}
