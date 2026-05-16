/**
 * Event emitter for learning worker — direct DB insert.
 */
import { drizzle }       from 'drizzle-orm/postgres-js'
import postgres          from 'postgres'
import { v7 as uuidv7 } from 'uuid'
import { EVENT_SCHEMA_VERSION } from '@ops/event-contracts'
import { events }        from '@ops/db'

const connectionString = process.env['DATABASE_URL']
if (!connectionString) throw new Error('DATABASE_URL is required')

const queryClient = postgres(connectionString, { max: 2, idle_timeout: 30 })
export const db   = drizzle(queryClient)

export async function emitEvent(
  type:        string,
  workspaceId: string,
  payload:     unknown,
  traceId?:    string,
): Promise<void> {
  if (!workspaceId) return
  const id  = uuidv7()
  const tid = traceId ?? id
  await db.insert(events).values({
    id,
    type,
    workspaceId,
    payload:       payload as Record<string, unknown>,
    traceId:       tid,
    correlationId: tid,
    causationId:   null,
    source:        'learning-worker',
    version:       EVENT_SCHEMA_VERSION,
    createdAt:     Date.now(),
  }).catch((err: unknown) => {
    console.error('Failed to persist learning event:', type, err)
  })
}
