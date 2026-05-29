/**
 * Disaster Recovery Service
 *
 * Detect and recover stuck workflows, orphan leases, and dead workers.
 * All recovery actions emit events for audit.
 */

import { v7 as uuidv7 }         from 'uuid'
import { and, eq, inArray, lt } from 'drizzle-orm'
import { db }                    from '../db/client.js'
import {
  workflowRuns, executionLeases, workerRegistry, events,
} from '../db/schema.js'
import { reclaimStaleLeases }   from './lease-manager.js'

// ─── Config ───────────────────────────────────────────────────────────────────

const STUCK_WORKFLOW_MS    = 30 * 60_000   // 30 min
const DEAD_WORKER_MS       = 2 * 60_000    // 2 min without heartbeat

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryReport {
  stuckWorkflows:    number
  orphanLeases:      number
  deadWorkers:       number
  errors:            string[]
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
    source: 'api/disaster-recovery', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Recovery operations ──────────────────────────────────────────────────────

/**
 * Mark stuck workflow runs as failed.
 * Stuck = running/pending for more than STUCK_WORKFLOW_MS.
 */
export async function recoverStuckWorkflows(workspaceId: string): Promise<number> {
  const cutoff = Date.now() - STUCK_WORKFLOW_MS
  const now    = Date.now()

  const stuck = await db.update(workflowRuns)
    .set({
      // workflowRuns has no `updatedAt` column — removing it removes the
      // `as never` cast that was hiding the schema mismatch. Drizzle was
      // silently dropping the field at runtime, so behavior is unchanged.
      status:       'failed',
      failedAt:     now,
      errorMessage: 'Automatically failed by disaster recovery (execution timeout)',
    })
    .where(and(
      eq(workflowRuns.workspaceId, workspaceId),
      inArray(workflowRuns.status, ['running', 'pending']),
      lt(workflowRuns.triggeredAt, cutoff),
    ))
    .returning({ id: workflowRuns.id })
    .catch(() => [] as { id: string }[])

  if (stuck.length > 0) {
    await emitEvent(workspaceId, 'recovery.stuck_workflows_failed', {
      runIds: stuck.map((r) => r.id),
      count: stuck.length,
    })
  }

  return stuck.length
}

/**
 * Reclaim orphaned execution leases (expired + no heartbeat renewal).
 */
export async function recoverOrphanLeases(workspaceId: string): Promise<number> {
  const count = await reclaimStaleLeases(workspaceId)

  if (count > 0) {
    await emitEvent(workspaceId, 'recovery.orphan_leases_reclaimed', { count })
  }

  return count
}

/**
 * Mark dead workers (no heartbeat for > DEAD_WORKER_MS) as offline.
 */
export async function recoverDeadWorkers(workspaceId: string): Promise<number> {
  const cutoff = Date.now() - DEAD_WORKER_MS
  const now    = Date.now()

  const dead = await db.update(workerRegistry)
    .set({ status: 'offline', updatedAt: now })
    .where(and(
      eq(workerRegistry.workspaceId, workspaceId),
      inArray(workerRegistry.status, ['idle', 'busy', 'draining']),
      lt(workerRegistry.lastHeartbeatAt, cutoff),
    ))
    .returning({ id: workerRegistry.id })
    .catch(() => [] as { id: string }[])

  if (dead.length > 0) {
    // Cancel their active leases too
    for (const w of dead) {
      await db.update(executionLeases)
        .set({ status: 'reclaimed', reclaimedAt: now, updatedAt: now })
        .where(and(
          eq(executionLeases.workerId, w.id),
          eq(executionLeases.status, 'active'),
        ))
        .catch(() => null)
    }
    await emitEvent(workspaceId, 'recovery.dead_workers_offlined', {
      workerIds: dead.map((w) => w.id),
      count: dead.length,
    })
  }

  return dead.length
}

/**
 * Run all disaster recovery routines for a workspace.
 */
export async function runDisasterRecovery(workspaceId: string): Promise<RecoveryReport> {
  const errors: string[] = []
  let stuckWorkflows = 0
  let orphanLeases   = 0
  let deadWorkers    = 0

  await recoverStuckWorkflows(workspaceId)
    .then((n) => { stuckWorkflows = n })
    .catch((e: unknown) => errors.push(`stuck_workflows: ${String(e)}`))

  await recoverOrphanLeases(workspaceId)
    .then((n) => { orphanLeases = n })
    .catch((e: unknown) => errors.push(`orphan_leases: ${String(e)}`))

  await recoverDeadWorkers(workspaceId)
    .then((n) => { deadWorkers = n })
    .catch((e: unknown) => errors.push(`dead_workers: ${String(e)}`))

  await emitEvent(workspaceId, 'recovery.disaster_recovery_completed', {
    stuckWorkflows, orphanLeases, deadWorkers, errors,
  }).catch(() => null)

  return { stuckWorkflows, orphanLeases, deadWorkers, errors }
}
