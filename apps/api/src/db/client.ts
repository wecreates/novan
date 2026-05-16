import { drizzle } from 'drizzle-orm/postgres-js'
import postgres     from 'postgres'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const queryClient = postgres(connectionString, {
  max:        20,
  idle_timeout: 30,
  connect_timeout: 10,
})

// Don't pass schema to drizzle — enums in schema break extractTablesRelationalConfig.
// All routes use the standard query builder API (db.select().from(...)) which works without it.
export const db = drizzle(queryClient)
export type DB  = typeof db
