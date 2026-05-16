/**
 * Replay Engine Service
 *
 * Replay workflow execution from event history.
 * Compares expected vs actual state to detect divergence.
 */

import { v7 as uuidv7 }   from 'uuid'
import { and, eq, asc }   from 'drizzle-orm'
import { db }              from '../db/client.js'
import {
  replayRuns, replayDivergences, events, workflowRuns,
} from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StartReplayInput {
  workspaceId:   string
  sourceRunId:   string
  checkpointId?: string
}

export interface ReplayResult {
  replayRunId:    string
  status:         string
  eventCount:     number
  replayedCount:  number
  divergences:    number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitEvent(
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/replay-engine', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Replay operations ────────────────────────────────────────────────────────

/**
 * Start a new replay run for a source workflow run.
 *
 * Loads events for the source run's trace, replays them in order,
 * compares expected vs actual state after each event, and records divergences.
 */
export async function startReplay(input: StartReplayInput): Promise<ReplayResult> {
  const now = Date.now()

  // Load the source run
  const [sourceRun] = await db.select().from(workflowRuns)
    .where(and(
      eq(workflowRuns.id, input.sourceRunId),
      eq(workflowRuns.workspaceId, input.workspaceId),
    ))

  if (!sourceRun) {
    throw new Error(`Source run ${input.sourceRunId} not found`)
  }

  // Create replay run record
  const replayId = uuidv7()
  const [replayRun] = await db.insert(replayRuns).values({
    id:           replayId,
    workspaceId:  input.workspaceId,
    sourceRunId:  input.sourceRunId,
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    status:       'running',
    eventCount:   0,
    replayedCount: 0,
    startedAt:    now,
    createdAt:    now,
    updatedAt:    now,
  }).returning()

  if (!replayRun) throw new Error('Failed to create replay run')

  await emitEvent(input.workspaceId, 'replay.started', {
    replayRunId: replayId,
    sourceRunId: input.sourceRunId,
  })

  // Load source run events by traceId
  const sourceEvents = await db.select().from(events)
    .where(and(
      eq(events.workspaceId, input.workspaceId),
      eq(events.traceId, sourceRun.traceId),
    ))
    .orderBy(asc(events.createdAt))

  const eventCount = sourceEvents.length
  let replayedCount = 0
  let divergenceCount = 0
  let divergedAtEventId: string | null = null
  let divergenceReason: string | null  = null

  // Replay each event: compare expected state with current run state
  // (State comparison: check if workflow run status matches expected progression)
  let expectedStatus = 'pending'

  for (const evt of sourceEvents) {
    try {
      // Derive expected state from event type
      const expectedState = deriveExpectedState(expectedStatus, evt.type)

      // Get current actual state
      const [currentRun] = await db.select().from(workflowRuns)
        .where(eq(workflowRuns.id, input.sourceRunId))

      const actualState = {
        status:     currentRun?.status ?? 'unknown',
        eventType:  evt.type,
        eventId:    evt.id,
      }

      // Detect divergence
      if (expectedState.status !== 'any' && actualState.status !== expectedState.status) {
        const divId = uuidv7()
        await db.insert(replayDivergences).values({
          id:             divId,
          workspaceId:    input.workspaceId,
          replayRunId:    replayId,
          eventId:        evt.id,
          eventType:      evt.type,
          expectedState:  expectedState,
          actualState:    actualState,
          divergenceType: 'state_mismatch',
          createdAt:      now,
        }).catch(() => null)

        divergenceCount++
        if (!divergedAtEventId) {
          divergedAtEventId = evt.id
          divergenceReason  = `State mismatch at ${evt.type}: expected ${expectedState.status}, got ${actualState.status}`
        }
      }

      expectedStatus = expectedState.nextStatus ?? expectedStatus
      replayedCount++
    } catch {
      // Record unexpected error divergence
      await db.insert(replayDivergences).values({
        id:             uuidv7(),
        workspaceId:    input.workspaceId,
        replayRunId:    replayId,
        eventId:        evt.id,
        eventType:      evt.type,
        expectedState:  { status: expectedStatus },
        actualState:    { error: 'unexpected_error' },
        divergenceType: 'unexpected_error',
        createdAt:      now,
      }).catch(() => null)

      divergenceCount++
      break
    }
  }

  // Finalize replay run
  const finalStatus = divergenceCount > 0 ? 'diverged' : 'completed'

  await db.update(replayRuns).set({
    status:           finalStatus,
    eventCount,
    replayedCount,
    ...(divergedAtEventId ? { divergedAtEventId, divergenceReason } : {}),
    completedAt:  Date.now(),
    updatedAt:    Date.now(),
  }).where(eq(replayRuns.id, replayId))

  await emitEvent(input.workspaceId, 'replay.completed', {
    replayRunId: replayId,
    status:      finalStatus,
    eventCount,
    replayedCount,
    divergences: divergenceCount,
  })

  return {
    replayRunId:   replayId,
    status:        finalStatus,
    eventCount,
    replayedCount,
    divergences:   divergenceCount,
  }
}

/** Simple event-to-state mapping for workflow replay. */
function deriveExpectedState(
  currentStatus: string,
  eventType:    string,
): { status: string; nextStatus?: string } {
  switch (eventType) {
    case 'workflow.started':
      return { status: 'any', nextStatus: 'running' }
    case 'workflow.completed':
      return { status: 'running', nextStatus: 'completed' }
    case 'workflow.failed':
      return { status: 'running', nextStatus: 'failed' }
    case 'workflow.cancelled':
      return { status: 'any', nextStatus: 'cancelled' }
    case 'workflow.paused':
      return { status: 'running', nextStatus: 'paused' }
    case 'workflow.resumed':
      return { status: 'paused', nextStatus: 'running' }
    default:
      // Generic events don't require state changes
      return { status: 'any', nextStatus: currentStatus }
  }
}

/** Get replay run with its divergences. */
export async function getReplayRun(
  replayRunId: string,
  workspaceId: string,
): Promise<{
  run: typeof replayRuns.$inferSelect | null
  divergences: (typeof replayDivergences.$inferSelect)[]
}> {
  const [run = null] = await db.select().from(replayRuns)
    .where(and(
      eq(replayRuns.id, replayRunId),
      eq(replayRuns.workspaceId, workspaceId),
    ))

  const divs = run
    ? await db.select().from(replayDivergences)
        .where(eq(replayDivergences.replayRunId, replayRunId))
    : []

  return { run, divergences: divs }
}

/** List all replay runs for a workspace. */
export async function listReplayRuns(
  workspaceId: string,
  sourceRunId?: string,
): Promise<(typeof replayRuns.$inferSelect)[]> {
  const q = db.select().from(replayRuns)
    .where(sourceRunId
      ? and(eq(replayRuns.workspaceId, workspaceId), eq(replayRuns.sourceRunId, sourceRunId))
      : eq(replayRuns.workspaceId, workspaceId),
    )
  return q
}
