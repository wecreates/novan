/**
 * Tests for worker-lease.ts — capability matching + isolation rules.
 *
 * Focus on pure logic (checkIsolationRules) plus exported constants.
 * Lease acquire/release is exercised via lock-manager pattern in the
 * lock-manager tests.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  function makeChain(): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve([])
          if (prop === 'catch') return () => makeChain()
          if (typeof prop === 'symbol') return undefined
          return () => makeChain()
        },
      },
    )
  }
  const db = {
    select: () => makeChain(),
    insert: () => ({ values: () => ({ then: (r: (v: unknown) => unknown) => r([]), catch: () => ({ then: (r: (v: unknown) => unknown) => r([]) }) }) }),
    update: () => ({ set: () => ({ where: () => ({ then: (r: (v: unknown) => unknown) => r([]) }) }) }),
  }
  return { db }
})

import {
  checkIsolationRules, ALLOWED_COMMANDS,
  HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS, MAX_RUNTIME_MS,
}                          from '../services/worker-lease.js'

const fullWorker = {
  workerId: 'worker-1',
  capabilities: ['typecheck', 'lint', 'test', 'build', 'scan', 'patch', 'verify'] as const,
}

// ─── A) Constants are sane ───────────────────────────────────────────────────

describe('worker-lease: constants', () => {
  it('HEARTBEAT_INTERVAL_MS < LEASE_TTL_MS (heartbeat must beat expiry)', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(LEASE_TTL_MS)
  })

  it('LEASE_TTL_MS is at least 2x HEARTBEAT_INTERVAL (network jitter)', () => {
    expect(LEASE_TTL_MS).toBeGreaterThanOrEqual(2 * HEARTBEAT_INTERVAL_MS)
  })

  it('MAX_RUNTIME_MS is at least 1 minute', () => {
    expect(MAX_RUNTIME_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('MAX_RUNTIME_MS is at most 1 hour (prevents runaway jobs)', () => {
    expect(MAX_RUNTIME_MS).toBeLessThanOrEqual(60 * 60_000)
  })

  it('ALLOWED_COMMANDS contains the core build commands', () => {
    expect(ALLOWED_COMMANDS.has('tsc')).toBe(true)
    expect(ALLOWED_COMMANDS.has('eslint')).toBe(true)
    expect(ALLOWED_COMMANDS.has('vitest')).toBe(true)
    expect(ALLOWED_COMMANDS.has('node')).toBe(true)
    expect(ALLOWED_COMMANDS.has('git')).toBe(true)
  })

  it('ALLOWED_COMMANDS does NOT contain dangerous binaries', () => {
    expect(ALLOWED_COMMANDS.has('rm')).toBe(false)
    expect(ALLOWED_COMMANDS.has('curl')).toBe(false)
    expect(ALLOWED_COMMANDS.has('wget')).toBe(false)
    expect(ALLOWED_COMMANDS.has('eval')).toBe(false)
  })
})

// ─── B) checkIsolationRules — command allowlist ─────────────────────────────

describe('checkIsolationRules: command allowlist', () => {
  it('allows known commands', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
    })
    expect(r).toBeNull() // null = passes all checks
  })

  it('rejects commands not on the allowlist', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'rm',
    })
    expect(r).not.toBeNull()
    expect(r).toMatch(/allowlist/i)
  })

  it('rejects shell-out attempts', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'curl',
    })
    expect(r).not.toBeNull()
  })
})

// ─── C) checkIsolationRules — job-status guard ───────────────────────────────

describe('checkIsolationRules: cancelled jobs', () => {
  it('refuses execution for cancelled jobs', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
      jobStatus: 'cancelled',
    })
    expect(r).not.toBeNull()
    expect(r).toMatch(/cancelled/i)
  })

  it('refuses execution for blocked jobs', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
      jobStatus: 'blocked',
    })
    expect(r).not.toBeNull()
    expect(r).toMatch(/blocked/i)
  })

  it('allows execution for running or queued jobs', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
      jobStatus: 'running',
    })
    expect(r).toBeNull()
  })
})

// ─── D) checkIsolationRules — max runtime guard ──────────────────────────────

describe('checkIsolationRules: runtime cap', () => {
  it('refuses when elapsed exceeds MAX_RUNTIME_MS', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
      elapsed: MAX_RUNTIME_MS + 1,
    })
    expect(r).not.toBeNull()
    expect(r).toMatch(/runtime/i)
  })

  it('allows when elapsed is under MAX_RUNTIME_MS', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
      elapsed: 30_000,
    })
    expect(r).toBeNull()
  })

  it('allows when elapsed is undefined', () => {
    const r = checkIsolationRules({
      worker: { ...fullWorker, capabilities: [...fullWorker.capabilities] },
      command: 'tsc',
    })
    expect(r).toBeNull()
  })
})

// ─── E) checkIsolationRules — capability match ──────────────────────────────

describe('checkIsolationRules: capability gate', () => {
  it('refuses tsc when worker lacks typecheck capability', () => {
    const r = checkIsolationRules({
      worker: { workerId: 'w', capabilities: ['lint'] },
      command: 'tsc',
    })
    expect(r).not.toBeNull()
    expect(r).toMatch(/capability/i)
  })

  it('allows tsc when worker has typecheck capability', () => {
    const r = checkIsolationRules({
      worker: { workerId: 'w', capabilities: ['typecheck'] },
      command: 'tsc',
    })
    expect(r).toBeNull()
  })

  it('allows vitest when worker has test capability', () => {
    const r = checkIsolationRules({
      worker: { workerId: 'w', capabilities: ['test'] },
      command: 'vitest',
    })
    expect(r).toBeNull()
  })
})

// ─── F) Multiple constraints aggregate ───────────────────────────────────────

describe('checkIsolationRules: priority order', () => {
  it('command allowlist is checked first (returns command-related error)', () => {
    const r = checkIsolationRules({
      worker: { workerId: 'w', capabilities: [] }, // no caps
      command: 'rm', // not allowed
      jobStatus: 'cancelled',
    })
    expect(r).toMatch(/allowlist/i)
  })

  it('cancelled status takes priority over capability check', () => {
    const r = checkIsolationRules({
      worker: { workerId: 'w', capabilities: [] }, // no caps
      command: 'tsc', // allowed
      jobStatus: 'cancelled',
    })
    expect(r).toMatch(/cancelled/i)
  })
})
