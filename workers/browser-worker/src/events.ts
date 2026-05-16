/**
 * Event emitter for browser-worker — persists to DB via @ops/db.
 */
import { db }              from './db.js'
import { events }          from '@ops/db'
import { v7 as uuidv7 }   from 'uuid'
import { EVENT_SCHEMA_VERSION } from '@ops/event-contracts'

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
    source:        'browser-worker',
    version:       EVENT_SCHEMA_VERSION,
    createdAt:     Date.now(),
  }).catch((err: unknown) => {
    console.error('[browser-worker] Failed to persist event:', type, err)
  })
}
