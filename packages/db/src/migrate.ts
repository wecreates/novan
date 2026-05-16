import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const sql = postgres(process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/ops', { max: 1 })
const db = drizzle(sql)

await migrate(db, { migrationsFolder: './migrations' })
console.log('Migrations complete')
await sql.end()
