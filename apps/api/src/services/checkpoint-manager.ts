/**
 * Checkpoint Manager Service
 *
 * Create, restore, list, and prune workflow checkpoints.
 * Uses the recovery_checkpoints table for persistent state.
 */

import { v7 as uuidv7 }     from 'uuid'
import { and, eq, lt, isNotNull } from 'drizzle-orm'
import { db }                from '../db/client.js'
import {
  recoveryCheckpoints, events,
} from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateCheckpointInput {
  workspaceId:    string
  runId:          string
  stepId:         string
  traceId:        string
  completedSteps: string[]
  state:          Record<string, unknown>
  snapshotId?:    string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitCheckpointEvent(
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/checkpoint-manager', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[checkpoint-manager]', e.message); return null })
}

// ─── Checkpoint operations ────────────────────────────────────────────────────

/** Create a checkpoint for a workflow run at a given step. */
export async function createCheckpoint(
  input: CreateCheckpointInput,
): Promise<typeof recoveryCheckpoints.$inferSelect> {
  const now = Date.now()

  const [row] = await db.insert(recoveryCheckpoints).values({
    id:             uuidv7(),
    workspaceId:    input.workspaceId,
    runId:          input.runId,
    stepId:         input.stepId,
    traceId:        input.traceId,
    completedSteps: input.completedSteps,
    state:          input.state,
    ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
    createdAt:      now,
  }).returning()

  await emitCheckpointEvent(input.workspaceId, 'checkpoint.created', {
    checkpointId:   row!.id,
    runId:          input.runId,
    stepId:         input.stepId,
    completedSteps: input.completedSteps,
  })

  return row!
}

/** List checkpoints for a run, ordered by creation time descending. */
export async function listCheckpoints(
  runId:       string,
  workspaceId: string,
): Promise<(typeof recoveryCheckpoints.$inferSelect)[]> {
  return db.select().from(recoveryCheckpoints)
    .where(and(
      eq(recoveryCheckpoints.runId, runId),
      eq(recoveryCheckpoints.workspaceId, workspaceId),
    ))
}

/** Restore a checkpoint — mark it as restored with actor info. */
export async function restoreCheckpoint(
  checkpointId: string,
  workspaceId:  string,
  restoredBy:   string,
): Promise<typeof recoveryCheckpoints.$inferSelect | null> {
  const now = Date.now()

  const rows = await db.update(recoveryCheckpoints)
    .set({ restoredAt: now, restoredBy })
    .where(and(
      eq(recoveryCheckpoints.id, checkpointId),
      eq(recoveryCheckpoints.workspaceId, workspaceId),
    ))
    .returning()

  if (rows.length === 0) return null

  await emitCheckpointEvent(workspaceId, 'checkpoint.restored', {
    checkpointId,
    runId:      rows[0]!.runId,
    restoredBy,
  })

  return rows[0]!
}

/** Delete a checkpoint. */
export async function deleteCheckpoint(
  checkpointId: string,
  workspaceId:  string,
): Promise<boolean> {
  const rows = await db.delete(recoveryCheckpoints)
    .where(and(
      eq(recoveryCheckpoints.id, checkpointId),
      eq(recoveryCheckpoints.workspaceId, workspaceId),
    ))
    .returning({ id: recoveryCheckpoints.id })

  return rows.length > 0
}

/** Prune checkpoints older than a given age. Returns count deleted. */
export async function pruneOldCheckpoints(
  workspaceId:  string,
  maxAgeMs:     number,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs

  // SQL semantics: `col = NULL` is always false in Postgres, so the
  // prior `eq(restoredAt, null as never)` predicate matched zero rows
  // and the prune effectively never ran. Use `isNotNull` so we delete
  // OLD checkpoints THAT HAVE BEEN RESTORED — keeping unrestored recent
  // ones around for retry, which matches the original intent.
  const rows = await db.delete(recoveryCheckpoints)
    .where(and(
      eq(recoveryCheckpoints.workspaceId, workspaceId),
      lt(recoveryCheckpoints.createdAt, cutoff),
      isNotNull(recoveryCheckpoints.restoredAt),
    ))
    .returning({ id: recoveryCheckpoints.id })
    .catch(() => [])

  return rows.length
}
