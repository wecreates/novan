/**
 * ExecutionTraceReader — ordered timeline of all events for a trace ID.
 * Read-only. Returns a flat, time-ordered event sequence.
 */
import { db } from '../db.js'
import { events, eventTraces, workflowTraces, taskTraces } from '@ops/db'
import { eq, asc } from 'drizzle-orm'

export interface ExecutionTraceEvent {
  id:        string
  type:      string
  source:    string
  payload:   Record<string, unknown>
  createdAt: number
}

/** Return all events associated with a traceId, ordered by time. */
export async function readExecutionTrace(traceId: string): Promise<ExecutionTraceEvent[]> {
  const rows = await db.select({
    id:        events.id,
    type:      events.type,
    source:    events.source,
    payload:   events.payload,
    createdAt: events.createdAt,
  }).from(events)
    .where(eq(events.traceId, traceId))
    .orderBy(asc(events.createdAt))

  return rows as ExecutionTraceEvent[]
}

export interface TraceTimeline {
  traceId:       string
  workflowTrace: typeof workflowTraces.$inferSelect | null
  taskTraces:    typeof taskTraces.$inferSelect[]
  eventTraces:   typeof eventTraces.$inferSelect[]
  events:        ExecutionTraceEvent[]
}

/** Full timeline for a trace ID across all trace tables. */
export async function readTraceTimeline(traceId: string): Promise<TraceTimeline> {
  const [wfTrace, tTraces, eTraces, evts] = await Promise.all([
    db.select().from(workflowTraces).where(eq(workflowTraces.traceId, traceId)).limit(1).then((r) => r[0] ?? null),
    db.select().from(taskTraces).where(eq(taskTraces.traceId, traceId)).orderBy(asc(taskTraces.createdAt)),
    db.select().from(eventTraces).where(eq(eventTraces.traceId, traceId)).orderBy(asc(eventTraces.createdAt)),
    readExecutionTrace(traceId),
  ])
  return { traceId, workflowTrace: wfTrace, taskTraces: tTraces, eventTraces: eTraces, events: evts }
}
