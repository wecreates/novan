/**
 * Tests for lock-manager.ts — Postgres-backed execution locks.
 *
 * Covers:
 * - acquireLock succeeds when no active lock exists
 * - acquireLock refuses when held by another holder
 * - acquireLock is re-entrant for the same holder (extends TTL)
 * - releaseLock succeeds for the holder, refuses for others
 * - isLocked reflects active lock state
 * - recoverStaleLocks runs without throwing on empty DB
 * - DEFAULT_LOCK_TTL_MS is a sane value
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockActiveRows: unknown[] = []
let mockReleaseRows: unknown[] = []
const inserts: unknown[] = []
const updates: unknown[] = []

// Drizzle helpers (and/eq/isNull/lt) are real — we just mock the db client.
vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[]): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(returnValue)
          if (prop === 'catch') return () => makeChain(returnValue)
          if (typeof prop === 'symbol') return undefined
          return () => makeChain(returnValue)
        },
      },
    )
  }
  // Toggle between activeRows + releaseRows by tracking call order
  let selectCallCount = 0
  const db = {
    select: () => {
      selectCallCount += 1
      // First select in recoverStaleLocks returns []; subsequent acquire-check
      // returns the active rows the test set. Then releaseLock select returns
      // the releaseRows.
      const rows = selectCallCount === 1 ? [] : (mockReleaseRows.length > 0 ? mockReleaseRows : mockActiveRows)
      return makeChain(rows)
    },
    insert: () => {
      const chain = {
        values: (v: unknown) => { inserts.push(v); return chain },
        onConflictDoNothing: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: (v: unknown) => { updates.push(v); return chain },
        where: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
  }
  return { db }
})

import {
  acquireLock, releaseLock, isLocked,
  recoverStaleLocks, DEFAULT_LOCK_TTL_MS,
}                          from '../services/lock-manager.js'

beforeEach(() => {
  mockActiveRows = []
  mockReleaseRows = []
  inserts.length = 0
  updates.length = 0
})

// ─── A) TTL constant ─────────────────────────────────────────────────────────

describe('lock-manager: constants', () => {
  it('DEFAULT_LOCK_TTL_MS is a positive duration', () => {
    expect(DEFAULT_LOCK_TTL_MS).toBeGreaterThan(0)
  })

  it('TTL is at least 1 minute (otherwise leases churn)', () => {
    expect(DEFAULT_LOCK_TTL_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('TTL is at most 1 hour (prevents zombie locks)', () => {
    expect(DEFAULT_LOCK_TTL_MS).toBeLessThanOrEqual(60 * 60_000)
  })
})

// ─── B) acquireLock — no active lock ─────────────────────────────────────────

describe('lock-manager: acquireLock empty state', () => {
  it('acquires lock when no row exists for resource', async () => {
    mockActiveRows = []
    const r = await acquireLock({
      workspaceId: 'ws', lockKind: 'file',
      resourceKey: 'src/x.ts', holderId: 'holder-a',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.lockId).toBeTruthy()
      expect(r.expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it('inserts a row when acquiring fresh', async () => {
    mockActiveRows = []
    await acquireLock({
      workspaceId: 'ws', lockKind: 'workflow',
      resourceKey: 'wf-1', holderId: 'h-1',
    })
    expect(inserts.length).toBeGreaterThan(0)
  })
})

// ─── C) acquireLock — re-entrant for same holder ─────────────────────────────

describe('lock-manager: acquireLock re-entrant', () => {
  it('extends TTL when same holder re-acquires', async () => {
    mockActiveRows = [{
      id: 'lock-1', holderId: 'holder-a',
      expiresAt: Date.now() + 60_000,
    }]
    const r = await acquireLock({
      workspaceId: 'ws', lockKind: 'file',
      resourceKey: 'src/x.ts', holderId: 'holder-a',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Same lock id returned; expiresAt was extended via update
      expect(r.lockId).toBe('lock-1')
      expect(updates.length).toBeGreaterThan(0)
    }
  })
})

// ─── D) acquireLock — conflict with different holder ────────────────────────

describe('lock-manager: acquireLock conflict', () => {
  it('refuses when another holder owns the lock', async () => {
    mockActiveRows = [{
      id: 'lock-1', holderId: 'holder-a',
      expiresAt: Date.now() + 60_000,
    }]
    const r = await acquireLock({
      workspaceId: 'ws', lockKind: 'file',
      resourceKey: 'src/x.ts', holderId: 'holder-b',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/locked by another holder/i)
      expect(r.currentHolder).toBe('holder-a')
    }
  })
})

// ─── E) releaseLock ──────────────────────────────────────────────────────────

describe('lock-manager: releaseLock', () => {
  it('returns false when lock id not found', async () => {
    mockReleaseRows = []
    const r = await releaseLock('nonexistent', 'holder-a')
    expect(r).toBe(false)
  })

  it('refuses release by wrong holder', async () => {
    mockReleaseRows = [{
      id: 'lock-1', workspaceId: 'ws',
      holderId: 'holder-a',
      lockKind: 'file', resourceKey: 'x',
      releasedAt: null,
    }]
    const r = await releaseLock('lock-1', 'holder-b')
    expect(r).toBe(false)
  })

  it('succeeds for correct holder', async () => {
    mockReleaseRows = [{
      id: 'lock-1', workspaceId: 'ws',
      holderId: 'holder-a',
      lockKind: 'file', resourceKey: 'x',
      releasedAt: null,
    }]
    const r = await releaseLock('lock-1', 'holder-a')
    expect(r).toBe(true)
  })

  it('idempotent — already-released lock returns true', async () => {
    mockReleaseRows = [{
      id: 'lock-1', workspaceId: 'ws',
      holderId: 'holder-a',
      lockKind: 'file', resourceKey: 'x',
      releasedAt: Date.now() - 1000,
    }]
    const r = await releaseLock('lock-1', 'holder-a')
    expect(r).toBe(true)
  })
})

// ─── F) isLocked ─────────────────────────────────────────────────────────────

describe('lock-manager: isLocked', () => {
  it('returns false when no active lock exists', async () => {
    mockActiveRows = []
    const r = await isLocked('ws', 'file', 'src/x.ts')
    expect(r).toBe(false)
  })

  it('returns true when an active lock exists', async () => {
    mockActiveRows = [{ id: 'lock-1' }]
    const r = await isLocked('ws', 'file', 'src/x.ts')
    expect(r).toBe(true)
  })
})

// ─── G) recoverStaleLocks ────────────────────────────────────────────────────

describe('lock-manager: recoverStaleLocks', () => {
  it('returns 0 when no stale locks exist', async () => {
    mockActiveRows = []
    const r = await recoverStaleLocks('ws')
    expect(r).toBe(0)
  })

  it('is safe to call repeatedly', async () => {
    mockActiveRows = []
    await recoverStaleLocks('ws')
    await recoverStaleLocks('ws')
    await recoverStaleLocks('ws')
    expect(true).toBe(true) // no throw
  })
})
