import { createDb, type DbClient } from '@ops/db'
const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')
export const db: DbClient = createDb(connectionString, 3)
