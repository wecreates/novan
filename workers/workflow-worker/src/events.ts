/**
 * Event emitter for workflow worker — persists events to DB via direct insert.
 * Workers don't call the API — they write directly to the events table.
 */
import { db }       from './db.js'
import { events }   from '@ops/db'
import { v7 as uuidv7 } from 'uuid'
import { EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

export async function emitEvent(
  type:        string,
  workspaceId: string,
  payload:     unknown,
  traceId?:    string,
): Promise<void> {
  if (!workspaceId) return   // skip events without workspace context

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
    source:        'workflow-worker',
    version:       EVENT_SCHEMA_VERSION,
    createdAt:     Date.now(),
  }).catch((err: unknown) => {
    console.error('Failed to persist event:', type, err)
  })
}
