/**
 * Event trace writer — persists an EventTrace record for each observed system event.
 * Called from the event bus listener or queue consumer.
 */
import { db } from '../db.js'
import { eventTraces } from '@ops/db'
import { v7 as uuidv7 } from 'uuid'
import { emitEvent } from '../events.js'

export interface RecordEventTraceInput {
  traceId:     string
  eventId:     string
  eventType:   string
  source:      string
  workspaceId: string
  payload:     Record<string, unknown>
}

export async function recordEventTrace(input: RecordEventTraceInput): Promise<string> {
  const id = uuidv7()
  await db.insert(eventTraces).values({
    id,
    workspaceId: input.workspaceId,
    traceId:     input.traceId,
    eventId:     input.eventId,
    eventType:   input.eventType,
    source:      input.source,
    payload:     input.payload,
    createdAt:   Date.now(),
  })
  await emitEvent('observability.trace.created', input.workspaceId, {
    traceId:    input.traceId,
    traceType:  'event' as const,
    workspaceId: input.workspaceId,
    refId:      input.eventId,
    refType:    input.eventType,
    timestamp:  Date.now(),
  }, input.traceId)
  return id
}
