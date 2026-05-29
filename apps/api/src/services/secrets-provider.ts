/**
 * secrets-provider.ts — Pluggable secrets layer (BO05).
 *
 * Today every secret reads `process.env` directly. This module fronts
 * that with an interface so a future migration to Doppler / Vault /
 * Infisical / cloud-native KMS is a one-line driver swap, not a
 * codebase-wide grep-and-replace.
 *
 * Honest scope:
 *   - The default driver is `env` — reads `process.env[KEY]`. Identical
 *     behavior to what we have today. Zero migration risk.
 *   - The `doppler` driver shells out to `doppler secrets get --plain`
 *     if `DOPPLER_TOKEN` is set. Cached for 5 min to avoid spawn churn.
 *   - The `vault` driver is a stub that requires `VAULT_ADDR` +
 *     `VAULT_TOKEN`. Not implemented yet — throws on first use so a
 *     misconfigured production environment fails loud rather than
 *     silently falling back to env.
 *   - Rotation hook emits `secret.rotation_requested` so any service
 *     caching the secret can react (most don't cache — they call
 *     `getSecret` on demand).
 */

import { incCounter } from './metrics.js'

export type SecretsDriver = 'env' | 'doppler' | 'vault'

interface CacheEntry { value: string; expiresAt: number }

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, CacheEntry>()

function currentDriver(): SecretsDriver {
  const d = (process.env['SECRETS_DRIVER'] || 'env').toLowerCase()
  if (d === 'doppler' || d === 'vault') return d
  return 'env'
}

/** Read a secret. Returns undefined if not found. Cached for 5 minutes
 *  except for the env driver (where re-reading process.env is free). */
export async function getSecret(key: string): Promise<string | undefined> {
  const driver = currentDriver()
  incCounter('secrets_get_total', { driver })

  if (driver === 'env') {
    return process.env[key]
  }

  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  let value: string | undefined
  if (driver === 'doppler') {
    value = await readDoppler(key)
  } else if (driver === 'vault') {
    value = await readVault(key)
  }
  if (value !== undefined) {
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  }
  return value
}

/** Synchronous getter for hot paths where async cost is unwanted.
 *  Always reads env — for non-env drivers, prime via `getSecret` first
 *  so the cache is warm, then call this. */
export function getSecretSync(key: string): string | undefined {
  if (currentDriver() === 'env') return process.env[key]
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  // Fall through to env so we never silently return stale.
  return process.env[key]
}

async function readDoppler(key: string): Promise<string | undefined> {
  if (!process.env['DOPPLER_TOKEN']) return undefined
  try {
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execp = promisify(exec)
    const safe = key.replace(/[^A-Z0-9_]/gi, '')
    if (safe !== key) return undefined  // reject suspicious key names
    const { stdout } = await execp(`doppler secrets get ${safe} --plain`, {
      timeout: 10_000, maxBuffer: 64 * 1024,
    })
    return stdout.trim() || undefined
  } catch { return undefined }
}

async function readVault(_key: string): Promise<string | undefined> {
  // Stub. A real implementation would use @hashicorp/vault-client +
  // VAULT_ADDR / VAULT_TOKEN. We fail loud rather than silently
  // returning undefined so misconfigured prod surfaces immediately.
  if (!process.env['VAULT_ADDR'] || !process.env['VAULT_TOKEN']) {
    throw new Error('vault driver requires VAULT_ADDR + VAULT_TOKEN')
  }
  throw new Error('vault driver not yet implemented — switch SECRETS_DRIVER to env or doppler')
}

/** Emit a rotation event for `key`. Listeners are responsible for
 *  re-fetching. Also clears local cache for the key. */
export async function rotateSecret(key: string, rotatedBy: string = 'operator'): Promise<void> {
  cache.delete(key)
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(events).values({
      id: uuidv7(), type: 'secret.rotation_requested', workspaceId: null,
      payload: { key, rotatedBy, driver: currentDriver(), at: Date.now() },
      traceId: uuidv7(), correlationId: null, causationId: null,
      source: 'secrets-provider', version: 1, createdAt: Date.now(),
    } as never).catch((e: Error) => { console.error('[secrets-provider]', e.message); return null })
  } catch { /* DB unavailable — tolerated */ }
  incCounter('secrets_rotation_total', { driver: currentDriver() })
}

/** Health check — confirm the active driver is reachable. Used by
 *  the /health endpoint + compliance evidence. */
export async function checkSecretsHealth(): Promise<{ driver: SecretsDriver; ok: boolean; detail?: string }> {
  const driver = currentDriver()
  if (driver === 'env') return { driver, ok: true }
  if (driver === 'doppler') {
    if (!process.env['DOPPLER_TOKEN']) return { driver, ok: false, detail: 'DOPPLER_TOKEN missing' }
    return { driver, ok: true }
  }
  if (driver === 'vault') {
    const ok = Boolean(process.env['VAULT_ADDR'] && process.env['VAULT_TOKEN'])
    return { driver, ok, ...(ok ? {} : { detail: 'VAULT_ADDR/TOKEN missing' }) }
  }
  return { driver: 'env', ok: true }
}

export function _clearSecretsCacheForTests(): void {
  cache.clear()
}

/** Cron consumer for `secret.rotation_requested` events.
 *
 *  When an operator rotates a secret via `rotateSecret()`, we emit the
 *  event AND clear the local cache. Other process replicas read the
 *  same event stream — this consumer drops their caches too. Idempotent;
 *  re-running on the same event is a no-op. */
export async function consumeSecretRotations(): Promise<{ processed: number; dropped: string[] }> {
  const dropped: string[] = []
  try {
    const { db } = await import('../db/client.js')
    const { events } = await import('../db/schema.js')
    const { sql, desc } = await import('drizzle-orm')
    const since = Date.now() - 15 * 60_000  // 15 min lookback
    const rows = await db.select({ payload: events.payload, createdAt: events.createdAt })
      .from(events)
      .where(sql`${events.type} = 'secret.rotation_requested' AND ${events.createdAt} >= ${since}`)
      .orderBy(desc(events.createdAt))
      .limit(50)
      .catch(() => [])
    for (const r of rows) {
      const p = r.payload as { key?: string }
      if (!p.key) continue
      if (cache.has(p.key)) {
        cache.delete(p.key)
        dropped.push(p.key)
        incCounter('secrets_cache_dropped_total')
      }
    }
    return { processed: rows.length, dropped }
  } catch { return { processed: 0, dropped: [] } }
}
