/**
 * R146.325 (#3) — Postgres advisory-lock helper for tick guards.
 *
 * Replaces in-process `_tickRunning = true` flags so the platform stays
 * correct under horizontal API scale. Single-instance deploys behave
 * identically; multi-instance deploys now serialize cron ticks across
 * containers via the shared Postgres lock space.
 *
 * Usage:
 *   const ok = await tryAdvisoryLock('tick:scheduled-production')
 *   if (!ok) return  // another instance is mid-tick
 *   try { await tick() } finally { await releaseAdvisoryLock(...) }
 *
 * Keys are hashed to bigint so any string name works.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

function keyFor(name: string): bigint {
  // Same algorithm as Postgres' hashtext, but JS-side for type stability.
  // 32-bit FNV-1a → bigint. Stable across runs.
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h = Math.imul((h ^ name.charCodeAt(i)) >>> 0, 0x01000193) >>> 0
  }
  return BigInt(h)
}

export async function tryAdvisoryLock(name: string): Promise<boolean> {
  const k = keyFor(name)
  try {
    const r = await db.execute(sql`SELECT pg_try_advisory_lock(${k}) AS locked`)
    const rows = (r as unknown as { rows?: Array<{ locked: boolean }> }).rows
      ?? (Array.isArray(r) ? r as Array<{ locked: boolean }> : [])
    return rows[0]?.locked === true
  } catch {
    // If we can't even reach Postgres, the tick is already in trouble —
    // fall back to letting the tick proceed (in-process flag still guards).
    return true
  }
}

export async function releaseAdvisoryLock(name: string): Promise<void> {
  const k = keyFor(name)
  try {
    await db.execute(sql`SELECT pg_advisory_unlock(${k})`)
  } catch { /* lock will release on session close regardless */ }
}

/** Run `body` while holding a Postgres advisory lock named `name`.
 *  Returns null if the lock couldn't be acquired (another instance has it). */
export async function withAdvisoryLock<T>(name: string, body: () => Promise<T>): Promise<T | null> {
  const ok = await tryAdvisoryLock(name)
  if (!ok) return null
  try { return await body() } finally { await releaseAdvisoryLock(name) }
}
