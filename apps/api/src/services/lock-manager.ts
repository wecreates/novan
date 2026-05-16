/**
 * lock-manager.ts — Persisted execution locks (file / workflow / queue / task).
 *
 * All locks are Postgres rows. One active lock per (kind, resourceKey).
 * Locks expire via TTL — stale locks are auto-recovered before acquire.
 *
 * Guarantees:
 * - Two agents cannot hold the same lock simultaneously
 * - Stale leases auto-released so progress never stalls
 * - All acquisitions/releases observable via runtime events
 */
import { db }             from '../db/client.js'
import { executionLocks, events } from '../db/schema.js'
import { eq, and, isNull, lt } from 'drizzle-orm'
import { v7 as uuidv7 }   from 'uuid'

export type LockKind = 'file' | 'workflow' | 'queue' | 'task'

export const DEFAULT_LOCK_TTL_MS = 5 * 60_000  // 5 min

async function emitEvent(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'lock-manager', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

// ─── Stale recovery ───────────────────────────────────────────────────────────

/** Mark expired locks as released. Safe to call repeatedly. */
export async function recoverStaleLocks(workspaceId: string): Promise<number> {
  const now = Date.now()
  // Find expired but not yet released
  const stale = await db.select({ id: executionLocks.id, lockKind: executionLocks.lockKind, resourceKey: executionLocks.resourceKey, holderId: executionLocks.holderId })
    .from(executionLocks)
    .where(and(
      eq(executionLocks.workspaceId, workspaceId),
      isNull(executionLocks.releasedAt),
      lt(executionLocks.expiresAt, now),
    ))
    .limit(100)

  if (stale.length === 0) return 0

  for (const s of stale) {
    await db.update(executionLocks).set({
      releasedAt:  now,
      recoveredAt: now,
    }).where(eq(executionLocks.id, s.id))

    await emitEvent(workspaceId, 'orchestrator.stale_lock_recovered', {
      lockId: s.id, lockKind: s.lockKind, resourceKey: s.resourceKey, previousHolder: s.holderId,
    })
  }
  return stale.length
}

// ─── Acquire ──────────────────────────────────────────────────────────────────

export type AcquireResult =
  | { ok: true;  lockId: string; expiresAt: number }
  | { ok: false; reason: string; currentHolder?: string }

export async function acquireLock(opts: {
  workspaceId: string
  lockKind:    LockKind
  resourceKey: string
  holderId:    string
  holderKind?: 'agent' | 'assignment' | 'worker'
  ttlMs?:      number
}): Promise<AcquireResult> {
  // Recover any stale locks first
  await recoverStaleLocks(opts.workspaceId)

  // Check for active lock on this resource
  const active = await db.select({
    id: executionLocks.id, holderId: executionLocks.holderId, expiresAt: executionLocks.expiresAt,
  }).from(executionLocks)
    .where(and(
      eq(executionLocks.workspaceId, opts.workspaceId),
      eq(executionLocks.lockKind, opts.lockKind),
      eq(executionLocks.resourceKey, opts.resourceKey),
      isNull(executionLocks.releasedAt),
    )).limit(1)

  if (active[0]) {
    if (active[0].holderId === opts.holderId) {
      // Re-entrant — extend TTL
      const now = Date.now()
      const newExpiry = now + (opts.ttlMs ?? DEFAULT_LOCK_TTL_MS)
      await db.update(executionLocks).set({ expiresAt: newExpiry })
        .where(eq(executionLocks.id, active[0].id))
      return { ok: true, lockId: active[0].id, expiresAt: newExpiry }
    }
    return {
      ok: false,
      reason: `Resource '${opts.lockKind}:${opts.resourceKey}' is locked by another holder`,
      currentHolder: active[0].holderId,
    }
  }

  // Insert new lock
  const now = Date.now()
  const id  = uuidv7()
  const expiresAt = now + (opts.ttlMs ?? DEFAULT_LOCK_TTL_MS)

  await db.insert(executionLocks).values({
    id,
    workspaceId: opts.workspaceId,
    lockKind:    opts.lockKind,
    resourceKey: opts.resourceKey,
    holderId:    opts.holderId,
    holderKind:  opts.holderKind ?? 'agent',
    acquiredAt:  now,
    expiresAt,
  })

  await emitEvent(opts.workspaceId, 'orchestrator.lock_acquired', {
    lockId: id, lockKind: opts.lockKind, resourceKey: opts.resourceKey, holderId: opts.holderId,
  })

  return { ok: true, lockId: id, expiresAt }
}

// ─── Release ──────────────────────────────────────────────────────────────────

export async function releaseLock(lockId: string, holderId: string): Promise<boolean> {
  const rows = await db.select().from(executionLocks).where(eq(executionLocks.id, lockId)).limit(1)
  const lock = rows[0]
  if (!lock) return false
  if (lock.holderId !== holderId) return false  // can't release another holder's lock
  if (lock.releasedAt) return true              // already released

  const now = Date.now()
  await db.update(executionLocks).set({ releasedAt: now }).where(eq(executionLocks.id, lockId))

  await emitEvent(lock.workspaceId, 'orchestrator.lock_released', {
    lockId, lockKind: lock.lockKind, resourceKey: lock.resourceKey, holderId,
  })
  return true
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function listActiveLocks(workspaceId: string) {
  return db.select().from(executionLocks)
    .where(and(
      eq(executionLocks.workspaceId, workspaceId),
      isNull(executionLocks.releasedAt),
    ))
    .limit(200)
}

export async function isLocked(workspaceId: string, kind: LockKind, key: string): Promise<boolean> {
  await recoverStaleLocks(workspaceId)
  const rows = await db.select({ id: executionLocks.id }).from(executionLocks)
    .where(and(
      eq(executionLocks.workspaceId, workspaceId),
      eq(executionLocks.lockKind, kind),
      eq(executionLocks.resourceKey, key),
      isNull(executionLocks.releasedAt),
    )).limit(1)
  return rows.length > 0
}
