/**
 * R423 — Cron health monitor.
 *
 * Wraps a cron-tick body so every invocation persists (cron_name, last_ran_at,
 * last_status, last_duration_ms, last_error). Dashboard surfaces stale
 * (no run in 25h for daily) or recently-failing crons in red.
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

async function ensureTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cron_health (
      name              TEXT PRIMARY KEY,
      last_ran_at       BIGINT NOT NULL,
      last_status       TEXT NOT NULL,     -- 'ok' | 'error'
      last_duration_ms  INTEGER NOT NULL,
      last_error        TEXT,
      ok_count          INTEGER NOT NULL DEFAULT 0,
      error_count       INTEGER NOT NULL DEFAULT 0
    )
  `).catch(() => {})
}

/** Run a cron-tick body and record health. Use as: cronHealth('name', () => doStuff()). */
export async function cronHealth<T>(name: string, body: () => Promise<T>): Promise<T | undefined> {
  await ensureTable()
  const start = Date.now()
  try {
    const r = await body()
    const dur = Date.now() - start
    await db.execute(sql`
      INSERT INTO cron_health (name, last_ran_at, last_status, last_duration_ms, last_error, ok_count, error_count)
      VALUES (${name}, ${start}, 'ok', ${dur}, NULL, 1, 0)
      ON CONFLICT (name) DO UPDATE
      SET last_ran_at = ${start}, last_status = 'ok', last_duration_ms = ${dur},
          last_error = NULL, ok_count = cron_health.ok_count + 1
    `).catch(() => {/* tolerated */})
    return r
  } catch (e) {
    const dur = Date.now() - start
    const msg = (e as Error).message.slice(0, 300)
    await db.execute(sql`
      INSERT INTO cron_health (name, last_ran_at, last_status, last_duration_ms, last_error, ok_count, error_count)
      VALUES (${name}, ${start}, 'error', ${dur}, ${msg}, 0, 1)
      ON CONFLICT (name) DO UPDATE
      SET last_ran_at = ${start}, last_status = 'error', last_duration_ms = ${dur},
          last_error = ${msg}, error_count = cron_health.error_count + 1
    `).catch(() => {/* tolerated */})
    throw e
  }
}

export interface CronHealthRow {
  name:             string
  lastRanAt:        number
  lastStatus:       string
  lastDurationMs:   number
  lastError:        string | null
  okCount:          number
  errorCount:       number
  staleHours:       number
}

export async function cronHealthSnapshot(): Promise<{ rows: CronHealthRow[]; failing: number; stale: number }> {
  await ensureTable()
  let rows: CronHealthRow[] = []
  let failing = 0, stale = 0
  try {
    const r = await db.execute(sql`SELECT name, last_ran_at, last_status, last_duration_ms, last_error, ok_count, error_count FROM cron_health ORDER BY last_ran_at DESC`)
    const now = Date.now()
    rows = (r as unknown as Array<{ name: string; last_ran_at: number; last_status: string; last_duration_ms: number; last_error: string | null; ok_count: number; error_count: number }>).map(x => {
      const staleH = Math.round((now - Number(x.last_ran_at)) / 3_600_000)
      if (x.last_status === 'error') failing++
      if (staleH > 25) stale++
      return {
        name: x.name,
        lastRanAt: Number(x.last_ran_at),
        lastStatus: x.last_status,
        lastDurationMs: Number(x.last_duration_ms),
        lastError: x.last_error,
        okCount: Number(x.ok_count),
        errorCount: Number(x.error_count),
        staleHours: staleH,
      }
    })
  } catch { /* tolerated */ }
  return { rows, failing, stale }
}
