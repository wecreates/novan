/**
 * CheckpointManager — saves and restores workflow execution state.
 *
 * A checkpoint captures the completed steps + runtime state at a given
 * point in execution. This enables:
 * - Safe replay from a known-good point
 * - Retry without re-running completed steps
 * - Recovery after worker crash
 *
 * Note: Restoring a checkpoint is READ-ONLY from the checkpoint perspective.
 * The executor is responsible for actually replaying the steps.
 */
import { db }                  from '../db.js'
import { recoveryCheckpoints } from '@ops/db'
import { eq, and }             from 'drizzle-orm'
import { v7 as uuidv7 }       from 'uuid'
import { emitEvent }           from '../events.js'

export interface CreateCheckpointInput {
  workspaceId:    string
  runId:          string
  stepId:         string
  traceId:        string
  completedSteps: string[]
  state:          Record<string, unknown>
  snapshotId?:    string
}

export async function createCheckpoint(input: CreateCheckpointInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()

  await db.insert(recoveryCheckpoints).values({
    id,
    workspaceId:    input.workspaceId,
    runId:          input.runId,
    stepId:         input.stepId,
    traceId:        input.traceId,
    completedSteps: input.completedSteps,
    state:          input.state,
    createdAt:      now,
    ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
  })

  await emitEvent('recovery.checkpoint.created', input.workspaceId, {
    checkpointId: id,
    workspaceId:  input.workspaceId,
    runId:        input.runId,
    stepId:       input.stepId,
    timestamp:    now,
  }, input.traceId)

  return id
}

/** Load the latest checkpoint for a run. */
export async function getLatestCheckpoint(runId: string): Promise<typeof recoveryCheckpoints.$inferSelect | null> {
  const [row] = await db.select()
    .from(recoveryCheckpoints)
    .where(eq(recoveryCheckpoints.runId, runId))
    .orderBy(recoveryCheckpoints.createdAt)
    .limit(1)
  return row ?? null
}

export async function getCheckpoint(checkpointId: string): Promise<typeof recoveryCheckpoints.$inferSelect | null> {
  const [row] = await db.select()
    .from(recoveryCheckpoints)
    .where(eq(recoveryCheckpoints.id, checkpointId))
    .limit(1)
  return row ?? null
}

/**
 * Mark a checkpoint as restored — records that the executor has
 * resumed from this checkpoint. Does NOT replay steps.
 */
export async function markCheckpointRestored(
  checkpointId: string,
  restoredBy:   string,
  traceId:      string,
): Promise<void> {
  const [row] = await db.select({ workspaceId: recoveryCheckpoints.workspaceId, runId: recoveryCheckpoints.runId, stepId: recoveryCheckpoints.stepId })
    .from(recoveryCheckpoints)
    .where(eq(recoveryCheckpoints.id, checkpointId))
    .limit(1)

  if (!row) return

  await db.update(recoveryCheckpoints)
    .set({ restoredAt: Date.now(), restoredBy })
    .where(and(eq(recoveryCheckpoints.id, checkpointId)))

  await emitEvent('recovery.checkpoint.restored', row.workspaceId, {
    checkpointId,
    workspaceId:  row.workspaceId,
    runId:        row.runId,
    restoredBy,
    timestamp:    Date.now(),
  }, traceId)
}
