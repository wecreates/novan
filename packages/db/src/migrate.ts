/**
 * R146.290 — migrate runner.
 *
 * Replaces the drizzle journal-based migrator (which only knew about
 * 3 of the 118 migrations because we authored most by hand).
 *
 * Now mirrors apps/api/boot.sh: walk *.sql in the migrations folder
 * (alphabetical glob order), skip any filename already in
 * schema_migrations_history, apply the rest with -v ON_ERROR_STOP=1
 * equivalent via postgres-js, record in the history table.
 *
 * Idempotent. Safe to re-run. Used by `pnpm run migrate` from any
 * shell — same behaviour as the container boot path so dev and prod
 * converge.
 */
import postgres from 'postgres'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  console.error('[migrate] DATABASE_URL is required')
  process.exit(1)
}

const sql = postgres(connectionString, {
  max: 1,
  connection: { application_name: 'ops-migrate' },
})

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(here, '..', 'migrations')

async function main(): Promise<void> {
  console.log('[migrate] ensuring schema_migrations_history…')
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations_history (
      filename text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `

  const files = (await readdir(MIGRATIONS_DIR))
    .filter(n => n.endsWith('.sql'))
    .sort()  // alphabetical — same order as boot.sh's glob

  // R146.325 (#14) — migration filename regex validation. Existing files
  // all match NNNN_name.sql. A misnamed migration (e.g. typo'd extension,
  // missing leading zero) would otherwise be silently skipped by boot.sh's
  // glob and never applied. Hard fail at boot instead.
  const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/
  const bad = files.filter(f => !MIGRATION_NAME.test(f))
  if (bad.length > 0) {
    console.error(`[migrate] malformed filenames (must match ^\\d{4}_[a-z0-9_]+\\.sql$): ${bad.join(', ')}`)
    process.exit(1)
  }

  const appliedRows = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations_history`
  const applied = new Set(appliedRows.map(r => r.filename))

  let appliedCount = 0
  let skippedCount = 0
  let failedCount  = 0

  for (const base of files) {
    if (applied.has(base)) {
      skippedCount++
      continue
    }
    console.log(`[migrate] applying ${base}…`)
    const content = await readFile(join(MIGRATIONS_DIR, base), 'utf8')
    try {
      await sql.unsafe(content)
      await sql`INSERT INTO schema_migrations_history (filename, applied_at) VALUES (${base}, ${Date.now()})`
      appliedCount++
    } catch (e) {
      console.error(`[migrate] FAILED ${base} — ${(e as Error).message.slice(0, 200)}`)
      failedCount++
    }
  }

  console.log(`[migrate] done — applied=${appliedCount} skipped=${skippedCount} failed=${failedCount}`)
  await sql.end()
  if (failedCount > 0) process.exit(1)
}

void main().catch(e => {
  console.error('[migrate]', e)
  process.exit(1)
})
