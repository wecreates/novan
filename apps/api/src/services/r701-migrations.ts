/**
 * R701 — Minimal schema-versioning over the existing IF NOT EXISTS pattern.
 *
 * Records every CREATE/ALTER the platform has applied. Lets `migrations.list`
 * surface drift and lets future migrations know what's already been done.
 * Doesn't replace the per-service `CREATE TABLE IF NOT EXISTS` calls — they
 * stay because they make local dev simple. This layer just observes them
 * so we have a single audit trail.
 */
import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

let ddlOk = false
async function ensureDdl(): Promise<void> {
  if (ddlOk) return
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS r701_migrations (
        version       TEXT PRIMARY KEY,
        round         TEXT,
        description   TEXT,
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `).catch(() => {})
    ddlOk = true
  } catch { /* tolerated */ }
}

export async function recordMigration(version: string, round: string, description: string): Promise<void> {
  await ensureDdl()
  try {
    await db.execute(sql`
      INSERT INTO r701_migrations (version, round, description)
      VALUES (${version}, ${round}, ${description})
      ON CONFLICT (version) DO NOTHING
    `)
  } catch { /* tolerated */ }
}

export async function listMigrations(): Promise<Array<Record<string, unknown>>> {
  await ensureDdl()
  try {
    const rows = await db.execute(sql`SELECT version, round, description, applied_at FROM r701_migrations ORDER BY applied_at DESC LIMIT 200`)
    return (rows.rows ?? rows) as Array<Record<string, unknown>>
  } catch { return [] }
}

export async function listKnownTables(): Promise<Array<{ table: string; rows: number }>> {
  try {
    const rows = await db.execute(sql`
      SELECT relname AS table, n_live_tup::int AS rows
      FROM pg_stat_user_tables
      WHERE relname LIKE 'r6%' OR relname LIKE 'r7%'
      ORDER BY relname
    `)
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map(r => ({
      table: String(r['table']), rows: Number(r['rows']),
    }))
  } catch { return [] }
}
