/**
 * Failure lineage — tracks the causal chain of events leading to a workflow failure.
 * Used to answer: "what sequence of events caused this run to fail?"
 */
import { db }              from '../db.js'
import { failureLineages } from '@ops/db'
import { eq }              from 'drizzle-orm'
import { v7 as uuidv7 }   from 'uuid'
import { emitEvent }       from '../events.js'

export interface FailureChainEntry {
  eventId:   string
  eventType: string
  timestamp: number
  message?:  string
}

export interface OpenFailureLineageInput {
  workspaceId:   string
  runId:         string
  traceId:       string
  failureChain:  FailureChainEntry[]
  affectedSteps: string[]
  rootCause?:    string
}

export async function openFailureLineage(input: OpenFailureLineageInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(failureLineages).values({
    id,
    workspaceId:      input.workspaceId,
    runId:            input.runId,
    traceId:          input.traceId,
    rootCause:        input.rootCause ?? null,
    failureChain:     input.failureChain,
    affectedSteps:    input.affectedSteps,
    recoveryAttempts: 0,
    resolved:         false,
    createdAt:        now,
    updatedAt:        now,
  })
  await emitEvent('observability.failure.linked', input.workspaceId, {
    failureId:      id,
    runId:          input.runId,
    linkedEventIds: input.failureChain.map((e) => e.eventId),
    rootCause:      input.rootCause ?? null,
    timestamp:      now,
  }, input.traceId)
  return id
}

export async function resolveFailureLineage(id: string): Promise<void> {
  await db.update(failureLineages)
    .set({ resolved: true, resolvedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(failureLineages.id, id))
}

export async function incrementRecoveryAttempts(id: string): Promise<void> {
  const [row] = await db.select({ n: failureLineages.recoveryAttempts })
    .from(failureLineages)
    .where(eq(failureLineages.id, id))
  if (!row) return
  await db.update(failureLineages)
    .set({ recoveryAttempts: row.n + 1, updatedAt: Date.now() })
    .where(eq(failureLineages.id, id))
}

/** Read the full failure lineage for a run. */
export async function getFailureLineage(runId: string): Promise<typeof failureLineages.$inferSelect | null> {
  const [row] = await db.select()
    .from(failureLineages)
    .where(eq(failureLineages.runId, runId))
    .limit(1)
  return row ?? null
}
