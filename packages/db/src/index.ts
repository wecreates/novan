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
export { startWorkerHeartbeat, type WorkerHeartbeatOpts } from './agent-heartbeat.js'

/** Create a Drizzle client bound to the given Postgres connection string.
 *  `applicationName` shows up in pg_stat_activity — set it per process
 *  (worker name, "ops-api", "migrate", "seed") so pool-exhaustion debugging
 *  doesn't require correlating opaque postgres-js connection IDs. */
export function createDb(connectionString: string, poolSize = 5, applicationName = 'ops-platform') {
  const client = postgres(connectionString, {
    max: poolSize,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { application_name: applicationName },
  })
  return drizzle(client)
}

export type DbClient = ReturnType<typeof createDb>
