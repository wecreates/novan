/**
 * Execution Lease Manager
 *
 * Manages job ownership by workers with timeout enforcement.
 * All operations are workspace-scoped and event-persisted.
 */

import { v7 as uuidv7 } from 'uuid'
import { and, eq, lt, sql } from 'drizzle-orm'
import { db }                from '../db/client.js'
import { executionLeases, workerRegistry, events, workerConcurrency } from '../db/schema.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeaseStatus  = 'active' | 'completed' | 'expired' | 'reclaimed' | 'cancelled'
export type LeaseJobType = 'ai' | 'browser' | 'remote' | 'workflow'

export interface CreateLeaseInput {
  workspaceId: string
  workerId:    string
  jobId:       string
  jobType:     LeaseJobType
  timeoutMs?:  number
  metadata?:   Record<string, unknown>
}

// ─── Event helper ─────────────────────────────────────────────────────────────

async function emitLeaseEvent(
  workspaceId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId,
    payload, traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/lease-manager', version: 1, createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[lease-manager]', e.message); return null })
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a new active lease for a job on a worker.
 * Increments worker activeLeases counter atomically.
 */
/**
 * Read the operator-set concurrency factor for a queue (jobType).
 * Returns 1.0 (no throttle) by default.
 * Workers consult this BEFORE creating a lease — see throttleFactor().
 */
export async function throttleFactor(workspaceId: string, jobType: LeaseJobType): Promise<number> {
  const row = await db.select().from(workerConcurrency)
    .where(and(eq(workerConcurrency.workspaceId, workspaceId), eq(workerConcurrency.queueName, jobType)))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[lease-manager]', e.message); return null })
  if (!row) return 1.0
  return Math.max(0, Math.min(2.0, Number(row.factor)))
}

export async function createLease(input: CreateLeaseInput): Promise<typeof executionLeases.$inferSelect> {
  const now       = Date.now()
  const timeoutMs = input.timeoutMs ?? 300_000

  const [lease] = await db.insert(executionLeases).values({
    id:          uuidv7(),
    workspaceId: input.workspaceId,
    workerId:    input.workerId,
    jobId:       input.jobId,
    jobType:     input.jobType,
    status:      'active',
    startedAt:   now,
    expiresAt:   now + timeoutMs,
    renewedAt:   null,
    completedAt: null,
    reclaimedAt: null,
    timeoutMs,
    costUsd:     0,
    metadata:    input.metadata ?? {},
    createdAt:   now,
    updatedAt:   now,
  }).returning()

  await db.update(workerRegistry)
    .set({
      activeLeases: sql`${workerRegistry.activeLeases} + 1`,
      updatedAt:    now,
    })
    .where(eq(workerRegistry.id, input.workerId))
    .catch((e: Error) => { console.error('[lease-manager]', e.message); return null })

  await emitLeaseEvent(input.workspaceId, 'lease.created', {
    leaseId: lease!.id, workerId: input.workerId, jobId: input.jobId, jobType: input.jobType,
  })

  return lease!
}

/**
 * Renew a lease, extending its expiry by timeoutMs from now.
 * Only active leases can be renewed.
 */
export async function renewLease(
  leaseId: string,
  workspaceId: string,
): Promise<typeof executionLeases.$inferSelect | null> {
  const rows = await db.select().from(executionLeases)
    .where(and(
      eq(executionLeases.id, leaseId),
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
    )).limit(1)

  const row = rows[0]
  if (!row) return null

  const now      = Date.now()
  const extended = now + row.timeoutMs

  const [updated] = await db.update(executionLeases)
    .set({ renewedAt: now, expiresAt: extended, updatedAt: now })
    .where(eq(executionLeases.id, leaseId))
    .returning()

  await emitLeaseEvent(workspaceId, 'lease.renewed', { leaseId, expiresAt: extended })
  return updated ?? null
}

/**
 * Mark a lease as completed and record final cost.
 * Decrements worker activeLeases (floor 0).
 */
export async function releaseLease(
  leaseId: string,
  workspaceId: string,
  costUsd = 0,
): Promise<boolean> {
  const now = Date.now()

  const rows = await db.update(executionLeases)
    .set({ status: 'completed', completedAt: now, costUsd, updatedAt: now })
    .where(and(
      eq(executionLeases.id, leaseId),
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
    ))
    .returning({ workerId: executionLeases.workerId })

  if (rows.length === 0) return false

  await db.update(workerRegistry)
    .set({
      activeLeases: sql`GREATEST(${workerRegistry.activeLeases} - 1, 0)`,
      updatedAt:    now,
    })
    .where(eq(workerRegistry.id, rows[0]!.workerId))
    .catch((e: Error) => { console.error('[lease-manager]', e.message); return null })

  await emitLeaseEvent(workspaceId, 'lease.completed', { leaseId, costUsd })
  return true
}

/**
 * Cancel a lease (e.g. job killed externally).
 */
export async function cancelLease(leaseId: string, workspaceId: string): Promise<boolean> {
  const now = Date.now()

  const rows = await db.update(executionLeases)
    .set({ status: 'cancelled', completedAt: now, updatedAt: now })
    .where(and(
      eq(executionLeases.id, leaseId),
      eq(executionLeases.workspaceId, workspaceId),
    ))
    .returning({ workerId: executionLeases.workerId })

  if (rows.length === 0) return false

  await db.update(workerRegistry)
    .set({
      activeLeases: sql`GREATEST(${workerRegistry.activeLeases} - 1, 0)`,
      updatedAt:    now,
    })
    .where(eq(workerRegistry.id, rows[0]!.workerId))
    .catch((e: Error) => { console.error('[lease-manager]', e.message); return null })

  await emitLeaseEvent(workspaceId, 'lease.cancelled', { leaseId })
  return true
}

/**
 * Get the current active lease for a given job (if any).
 */
export async function getActiveLease(
  jobId: string,
  workspaceId: string,
): Promise<typeof executionLeases.$inferSelect | null> {
  const rows = await db.select().from(executionLeases)
    .where(and(
      eq(executionLeases.jobId, jobId),
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
    )).limit(1)

  return rows[0] ?? null
}

/**
 * Reclaim all expired active leases for a workspace.
 * Returns the count of leases reclaimed.
 */
export async function reclaimStaleLeases(workspaceId: string): Promise<number> {
  const now = Date.now()

  const expired = await db.update(executionLeases)
    .set({ status: 'reclaimed', reclaimedAt: now, updatedAt: now })
    .where(and(
      eq(executionLeases.workspaceId, workspaceId),
      eq(executionLeases.status, 'active'),
      lt(executionLeases.expiresAt, now),
    ))
    .returning({ id: executionLeases.id, workerId: executionLeases.workerId })

  if (expired.length === 0) return 0

  // Batch decrement per worker
  const perWorker = new Map<string, number>()
  for (const { workerId } of expired) {
    perWorker.set(workerId, (perWorker.get(workerId) ?? 0) + 1)
  }
  for (const [wid, count] of perWorker) {
    await db.update(workerRegistry)
      .set({
        activeLeases: sql`GREATEST(${workerRegistry.activeLeases} - ${count}, 0)`,
        updatedAt:    now,
      })
      .where(eq(workerRegistry.id, wid))
      .catch((e: Error) => { console.error('[lease-manager]', e.message); return null })
  }

  await emitLeaseEvent(workspaceId, 'lease.reclaimed_batch', {
    count: expired.length, leaseIds: expired.map((r) => r.id),
  })

  return expired.length
}
