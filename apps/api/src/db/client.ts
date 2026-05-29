import { drizzle } from 'drizzle-orm/postgres-js'
import postgres     from 'postgres'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const queryClient = postgres(connectionString, {
  // Bumped from 20 because pg.listen() (used by brain SSE stream) holds
  // a dedicated connection per LISTEN that's not released back to the
  // pool until the stream closes. Multiple open SSE streams quickly
  // exhausted the pool, leaving regular queries waiting indefinitely
  // (the chat + brain hang we hunted across multiple boot tests).
  // 60 gives headroom; postgres default max_connections is 100.
  max:        60,
  idle_timeout: 30,
  connect_timeout: 10,
  // Tagged so pg_stat_activity shows which process is holding each
  // connection — invaluable when debugging "why is the pool exhausted".
  connection: { application_name: 'ops-api' },
})

// Don't pass schema to drizzle — enums in schema break extractTablesRelationalConfig.
// All routes use the standard query builder API (db.select().from(...)) which works without it.
export const db = drizzle(queryClient)
export type DB  = typeof db

// Exposed raw client for postgres-js features Drizzle doesn't wrap —
// specifically LISTEN/NOTIFY for sub-second SSE notifications.
export const pg = queryClient
