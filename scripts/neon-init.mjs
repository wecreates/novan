import postgres from '../node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js'
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' })
try {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`
  console.log('vector enabled')
  await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
  console.log('uuid-ossp enabled')
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`
  console.log('pgcrypto enabled')
} catch (e) { console.error('error:', e.message); process.exit(1) }
finally { await sql.end() }
