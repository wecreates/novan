/**
 * Worker DB client — dedicated connection pool, isolated from API.
 */
import { createDb } from '@ops/db'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

export const db = createDb(connectionString, 5, 'ops-workflow-worker')
