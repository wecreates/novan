/**
 * R504 — Postgres advisory lock for cron tick overlap protection.
 *
 * Wraps a cron body in pg_try_advisory_lock so a slow run doesn't overlap
 * with the next tick. If lock can't be acquired, throws CronSkip so
 * cron_health records 'skipped: overlap' instead of double-firing the body.
 *
 * Lock ID is a stable hash of the cron name. Two different cron names get
 * different lock IDs and run independently.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { CronSkip } from './r423-cron-health.js'

function hashCronName(name: string): number {
  // 32-bit FNV-1a, then keep in [1, 2^31-1] so it fits a signed int
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return (h & 0x7fffffff) | 1
}

export async function withCronLock<T>(name: string, body: () => Promise<T>): Promise<T | undefined> {
  const lockId = hashCronName(name)
  let acquired = false
  try {
    const r = await db.execute(sql`SELECT pg_try_advisory_lock(${lockId}) AS got`)
    const rows = r as unknown as { rows?: Array<{ got: boolean }> } | Array<{ got: boolean }>
    const arr = Array.isArray(rows) ? rows : (rows.rows ?? [])
    acquired = Boolean(arr[0]?.got)
    if (!acquired) throw new CronSkip(`previous ${name} still running (advisory-lock contention)`)
    return await body()
  } finally {
    if (acquired) {
      await db.execute(sql`SELECT pg_advisory_unlock(${lockId})`).catch(() => {/* tolerated */})
    }
  }
}
