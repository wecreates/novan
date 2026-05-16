/**
 * Database client for browser-worker.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres    from 'postgres'
const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const queryClient = postgres(connectionString, { max: 3, idle_timeout: 30, connect_timeout: 10 })
export const db = drizzle(queryClient)
export { queryClient }
