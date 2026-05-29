import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Fail-fast if DATABASE_URL is missing — silently falling back to the
// hardcoded localhost:5432 default could run migrations against a stale
// dev DB or, worse, mask a misconfigured production deploy.
const connectionString = process.env['DATABASE_URL']
if (!connectionString) {
  console.error('[migrate] DATABASE_URL is required')
  process.exit(1)
}
const sql = postgres(connectionString, {
  max: 1,
  connection: { application_name: 'ops-migrate' },
})
const db = drizzle(sql)

await migrate(db, { migrationsFolder: './migrations' })
console.log('Migrations complete')
await sql.end()
