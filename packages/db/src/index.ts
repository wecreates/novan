/**
 * @ops/db — shared database schema and connection factory.
 *
 * Usage:
 *   import { createDb } from '@ops/db'
 *   const db = createDb(process.env.DATABASE_URL!)
 *
 * Or import individual tables:
 *   import { workflowRuns, events } from '@ops/db'
 *
 * NOTE: schema is NOT passed to drizzle() to avoid enum prototype issues
 * in extractTablesRelationalConfig. All queries use the standard query builder.
 */
import { drizzle }  from 'drizzle-orm/postgres-js'
import postgres      from 'postgres'
import * as schema   from './schema.js'

export * from './schema.js'
export { schema }

/** Create a Drizzle client bound to the given Postgres connection string. */
export function createDb(connectionString: string, poolSize = 5) {
  const client = postgres(connectionString, { max: poolSize, idle_timeout: 30 })
  return drizzle(client)
}

export type DbClient = ReturnType<typeof createDb>
