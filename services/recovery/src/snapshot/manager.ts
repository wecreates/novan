/**
 * SnapshotManager — lifecycle for creating and finalizing snapshots.
 *
 * A snapshot captures the "before state" of all entities a step
 * might modify, enabling deterministic rollback.
 *
 * Snapshot states: active → superseded | expired | deleted
 * Only active snapshots can be used for rollback.
 */
import { db }        from '../db.js'
import { snapshots } from '@ops/db'
import { eq }        from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { emitEvent } from '../events.js'

export interface CreateSnapshotInput {
  workspaceId: string
  runId:       string
  traceId:     string
  stepId?:     string
  description?: string
  expiresAt?:  number
}

export async function createSnapshot(input: CreateSnapshotInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()

  try {
    await db.insert(snapshots).values({
      id,
      workspaceId: input.workspaceId,
      runId:       input.runId,
      traceId:     input.traceId,
      status:      'active',
      itemCount:   0,
      sizeBytes:   0,
      createdAt:   now,
      ...(input.stepId      !== undefined ? { stepId:      input.stepId      } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.expiresAt   !== undefined ? { expiresAt:   input.expiresAt   } : {}),
    })

    await emitEvent('snapshot.created', input.workspaceId, {
      workspaceId: input.workspaceId,
      snapshotId:  id,
      runId:       input.runId,
      itemCount:   0,
      timestamp:   now,
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    }, input.traceId)

    return id
  } catch (err: unknown) {
    await emitEvent('snapshot.failed', input.workspaceId, {
      workspaceId: input.workspaceId,
      runId:       input.runId,
      error:       (err as Error).message,
      timestamp:   now,
      ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    }, input.traceId)
    throw err
  }
}

/** Update item count and size after adding items. */
export async function finalizeSnapshot(
  snapshotId:  string,
  itemCount:   number,
  sizeBytes:   number,
): Promise<void> {
  await db.update(snapshots)
    .set({ itemCount, sizeBytes })
    .where(eq(snapshots.id, snapshotId))
}

/** Mark a snapshot as superseded (a newer one now applies). */
export async function supersede(snapshotId: string): Promise<void> {
  await db.update(snapshots)
    .set({ status: 'superseded' })
    .where(eq(snapshots.id, snapshotId))
}

export async function getSnapshot(snapshotId: string): Promise<typeof snapshots.$inferSelect | null> {
  const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).limit(1)
  return row ?? null
}

/** Find the most recent active snapshot for a run. */
export async function getLatestSnapshot(runId: string): Promise<typeof snapshots.$inferSelect | null> {
  const [row] = await db.select().from(snapshots)
    .where(eq(snapshots.runId, runId))
    .orderBy(snapshots.createdAt)
    .limit(1)
  return (row?.status === 'active' ? row : null) ?? null
}
