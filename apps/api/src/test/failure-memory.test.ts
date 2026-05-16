/**
 * Tests for failure-memory.ts — the closed learning loop.
 *
 * Covers:
 * A) buildSignature is pure + deterministic + normalises numbers/hex
 * B) checkBeforePatch decision boundaries (allow / warn / block)
 *
 * Uses the shared db Proxy mock pattern (no real Postgres).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock DB before importing the module under test ───────────────────────────
// State that individual tests mutate via mockReturnedRows
let mockRows: unknown[] = []
const insertCalls: unknown[] = []
const updateCalls: unknown[] = []

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = mockRows): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          // Promise-like terminal
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(returnValue)
          if (prop === 'catch') return () => makeChain(returnValue)
          if (typeof prop === 'symbol') return undefined
          // chaining continues
          return () => makeChain(returnValue)
        },
      },
    )
  }
  const db = {
    select: () => makeChain(),
    insert: () => {
      const chain = {
        values: (v: unknown) => { insertCalls.push(v); return chain },
        onConflictDoNothing: () => chain,
        returning: () => makeChain([]),
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: (v: unknown) => { updateCalls.push(v); return chain },
        where: () => chain,
        returning: () => makeChain([]),
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    delete: () => ({
      where: () => ({ then: (r: (v: unknown) => unknown) => r([]) }),
    }),
  }
  return { db }
})

import {
  buildSignature, recordFailure, checkBeforePatch,
  REPEAT_WARN_THRESHOLD, REPEAT_BLOCK_THRESHOLD,
}                          from '../services/failure-memory.js'

beforeEach(() => {
  mockRows = []
  insertCalls.length = 0
  updateCalls.length = 0
})

// ─── A) buildSignature pure logic ─────────────────────────────────────────────

describe('failure-memory: buildSignature', () => {
  it('is deterministic — same inputs produce same signature', () => {
    const a = buildSignature({
      failureType: 'patch', targetRef: 'src/x.ts',
      rootCauseClass: 'runtime', errorMessage: 'TypeError: foo',
    })
    const b = buildSignature({
      failureType: 'patch', targetRef: 'src/x.ts',
      rootCauseClass: 'runtime', errorMessage: 'TypeError: foo',
    })
    expect(a.signature).toBe(b.signature)
  })

  it('normalises numbers in error message — line numbers differ but signature matches', () => {
    const a = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'runtime', errorMessage: 'TypeError at line 42',
    })
    const b = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'runtime', errorMessage: 'TypeError at line 7',
    })
    expect(a.signature).toBe(b.signature)
  })

  it('normalises hex pointers', () => {
    const a = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'runtime', errorMessage: 'Bad ptr 0xdeadbeef',
    })
    const b = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'runtime', errorMessage: 'Bad ptr 0xcafef00d',
    })
    expect(a.signature).toBe(b.signature)
  })

  it('different rootCauseClass → different signature', () => {
    const a = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'runtime', errorMessage: 'X',
    })
    const b = buildSignature({
      failureType: 'patch', targetRef: 'x.ts',
      rootCauseClass: 'syntax', errorMessage: 'X',
    })
    expect(a.signature).not.toBe(b.signature)
  })

  it('different targetRef → different signature', () => {
    const a = buildSignature({
      failureType: 'patch', targetRef: 'a.ts',
      rootCauseClass: 'runtime', errorMessage: 'X',
    })
    const b = buildSignature({
      failureType: 'patch', targetRef: 'b.ts',
      rootCauseClass: 'runtime', errorMessage: 'X',
    })
    expect(a.signature).not.toBe(b.signature)
  })

  it('lowercases + strips extra whitespace in error pattern', () => {
    const { errorPattern } = buildSignature({
      failureType: 'patch', targetRef: 'x',
      rootCauseClass: 'runtime', errorMessage: '   HELLO   World  ',
    })
    expect(errorPattern.includes('hello')).toBe(true)
    expect(errorPattern.includes('world')).toBe(true)
  })

  it('signature is a hex string of length 16', () => {
    const { signature } = buildSignature({
      failureType: 'patch', targetRef: 'x',
      rootCauseClass: 'runtime', errorMessage: 'anything',
    })
    expect(signature).toMatch(/^[a-f0-9]{16}$/)
  })

  it('signature is bounded — works on huge error messages', () => {
    const huge = 'x'.repeat(50_000)
    expect(() => buildSignature({
      failureType: 'patch', targetRef: 'x',
      rootCauseClass: 'runtime', errorMessage: huge,
    })).not.toThrow()
  })
})

// ─── B) checkBeforePatch decision boundaries ─────────────────────────────────

describe('failure-memory: checkBeforePatch decision boundary', () => {
  it('returns allow when no prior failure exists', async () => {
    mockRows = []
    const r = await checkBeforePatch({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x', errorMessage: 'e',
    })
    expect(r.decision).toBe('allow')
    expect(r.memoryId).toBeNull()
    expect(r.occurrenceCount).toBe(0)
  })

  it('returns block decision when memory.blocked=true', async () => {
    mockRows = [{
      id: 'mem-1', signature: 'sig', occurrenceCount: 5,
      blocked: true, errorPattern: 'e', targetRef: 'x',
    }]
    const r = await checkBeforePatch({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x', errorMessage: 'e',
    })
    expect(r.decision).toBe('block')
    expect(r.reason).toMatch(/repeat|attempted/i)
  })

  it('returns block when occurrenceCount hits threshold', async () => {
    mockRows = [{
      id: 'mem-1', signature: 'sig',
      occurrenceCount: REPEAT_BLOCK_THRESHOLD,
      blocked: false, errorPattern: 'e', targetRef: 'x',
    }]
    const r = await checkBeforePatch({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x', errorMessage: 'e',
    })
    expect(r.decision).toBe('block')
  })

  it('returns warn when occurrenceCount is between WARN and BLOCK', async () => {
    mockRows = [{
      id: 'mem-1', signature: 'sig',
      occurrenceCount: REPEAT_WARN_THRESHOLD,
      blocked: false, errorPattern: 'e', targetRef: 'x',
    }]
    const r = await checkBeforePatch({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x', errorMessage: 'e',
    })
    expect(r.decision).toBe('warn')
  })

  it('returns allow when occurrenceCount is below warn threshold', async () => {
    mockRows = [{
      id: 'mem-1', signature: 'sig',
      occurrenceCount: 1, // below WARN(2)
      blocked: false, errorPattern: 'e', targetRef: 'x',
    }]
    const r = await checkBeforePatch({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x', errorMessage: 'e',
    })
    expect(r.decision).toBe('allow')
    expect(r.occurrenceCount).toBe(1)
  })
})

// ─── C) recordFailure contract ───────────────────────────────────────────────

describe('failure-memory: recordFailure', () => {
  it('throws if evidenceIds is empty (no fake learning)', async () => {
    await expect(recordFailure({
      workspaceId: 'ws', failureType: 'patch',
      rootCauseClass: 'runtime', targetRef: 'x',
      targetKind: 'file', errorMessage: 'e', evidenceIds: [],
    })).rejects.toThrow(/evidenceIds required/i)
  })

  it('threshold constants are sane', () => {
    expect(REPEAT_WARN_THRESHOLD).toBeGreaterThan(0)
    expect(REPEAT_BLOCK_THRESHOLD).toBeGreaterThan(REPEAT_WARN_THRESHOLD)
  })
})
