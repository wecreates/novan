/**
 * Cancellation Service
 *
 * Cancel workflow runs, queue jobs, and execution leases.
 * Persists cancellation events for audit.
 */

import { v7 as uuidv7 }         from 'uuid'
import { and, eq, inArray }     from 'drizzle-orm'
import { db }                    from '../db/client.js'
import {
  events, workflowRuns, executionLeases,
} from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CancelResult {
  cancelled: boolean
  reason:    string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function emitCancelEvent(
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/cancellation', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Workflow run cancellation ────────────────────────────────────────────────

/**
 * Cancel a workflow run (and all its active leases).
 * Transitions status → cancelled; emits run.cancelled event.
 */
export async function cancelWorkflowRun(
  runId:       string,
  workspaceId: string,
  reason:      string,
  cancelledBy: string,
): Promise<CancelResult> {
  const now = Date.now()

  // workflowRuns has no `updatedAt` column — removing the bogus field
  // also removes the `as never` cast that was hiding the schema mismatch.
  // Drizzle was silently dropping the field at runtime, so behavior is
  // unchanged; the lie is just gone.
  const rows = await db.update(workflowRuns)
    .set({
      status:      'cancelled',
      completedAt: now,
      errorMessage: `Cancelled: ${reason}`,
    })
    .where(and(
      eq(workflowRuns.id, runId),
      eq(workflowRuns.workspaceId, workspaceId),
      inArray(workflowRuns.status, ['pending', 'running', 'paused', 'awaiting_approval']),
    ))
    .returning({ id: workflowRuns.id })

  if (rows.length === 0) {
    return { cancelled: false, reason: 'Run not found or already in terminal state' }
  }

  // Cancel all active leases for this run's jobs
  await db.update(executionLeases)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
    ))
    .catch(() => null)

  await emitCancelEvent(workspaceId, 'run.cancelled', {
    runId, reason, cancelledBy, cancelledAt: now,
  })

  return { cancelled: true, reason }
}

// ─── Lease cancellation ───────────────────────────────────────────────────────

/**
 * Cancel a specific execution lease.
 */
export async function cancelExecutionLease(
  leaseId:     string,
  workspaceId: string,
  reason:      string,
): Promise<CancelResult> {
  const now = Date.now()

  const rows = await db.update(executionLeases)
    .set({ status: 'cancelled', updatedAt: now })
    .where(and(
      eq(executionLeases.id, leaseId),
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
    ))
    .returning({ id: executionLeases.id, jobId: executionLeases.jobId })

  if (rows.length === 0) {
    return { cancelled: false, reason: 'Lease not found or not active' }
  }

  await emitCancelEvent(workspaceId, 'lease.cancelled', {
    leaseId, jobId: rows[0]!.jobId, reason, cancelledAt: now,
  })

  return { cancelled: true, reason }
}
