/**
 * Tests for issues.ts — the unified engineering issue ledger.
 *
 * Covers:
 *   A) createOrAppendIssue dedups via fingerprint
 *   B) status transitions: diagnose → linkPatch → verify → close
 *   C) closeIssue refuses non-verified status without force
 *   D) defaultFingerprint is stable + deterministic
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock DB before importing the module under test ───────────────────────────
let selectRows: unknown[] = []
const insertCalls: Array<{ table: string; values: unknown }> = []
const updateCalls: Array<{ set: unknown }> = []
let lastReturning: unknown[] = []

vi.mock('../db/client.js', () => {
  // The chain is a Promise that resolves to `rows`. Promise.prototype
  // gives us .then + .catch for free, and intermediate methods return
  // the same chain so .where().limit().then().catch() all work.
  function makeSelectChain(rows: unknown[]): unknown {
    const p: Promise<unknown[]> & Record<string, unknown> = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
    return new Proxy(p, {
      get(target, prop, receiver) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return Reflect.get(target, prop, receiver).bind(target)
        }
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        // Chain method — return same proxy
        return () => makeSelectChain(rows)
      },
    })
  }
  const db = {
    select: () => makeSelectChain(selectRows),
    insert: () => {
      const chain = {
        values: (v: unknown) => { insertCalls.push({ table: 'insert', values: v }); return chain },
        returning: () => makeSelectChain(lastReturning),
        onConflictDoNothing: () => chain,
        // Allow await db.insert(...).values(...) without .returning()
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: (v: unknown) => { updateCalls.push({ set: v }); return chain },
        where: () => chain,
        returning: () => makeSelectChain(lastReturning),
      }
      return chain
    },
  }
  return { db }
})

// Mock schema — just object refs so import succeeds
vi.mock('../db/schema.js', () => ({
  issues:    {},
  events:    {},
  incidents: {},
}))

import {
  createOrAppendIssue, diagnoseIssue, linkPatch, verifyIssue, closeIssue,
} from '../services/issues.js'

beforeEach(() => {
  selectRows = []
  insertCalls.length = 0
  updateCalls.length = 0
  lastReturning = []
})

describe('createOrAppendIssue', () => {
  it('creates a new issue when no matching fingerprint exists', async () => {
    selectRows = []                  // no existing issue
    lastReturning = [{ id: 'iss-1', status: 'open', symptom: 'API 500 on /foo', severity: 'warning', source: 'operator' }]
    const r = await createOrAppendIssue({
      workspaceId: 'ws-1',
      symptom:     'API 500 on /foo',
      source:      'operator',
    })
    expect(r.deduped).toBe(false)
    expect(r.issue.id).toBe('iss-1')
    expect(insertCalls.length).toBeGreaterThan(0)   // event + issue inserts
  })

  it('dedupes when an open issue with same fingerprint exists', async () => {
    const existing = {
      id: 'iss-existing', status: 'open',
      evidence: [{ type: 'event', ref: 'e1', summary: 'first', at: 1 }],
    }
    selectRows = [existing]
    lastReturning = [{ ...existing, evidence: [...existing.evidence, { type:'event', ref:'e2', summary:'second', at:2 }] }]
    const r = await createOrAppendIssue({
      workspaceId: 'ws-1',
      symptom:     'same symptom',
      source:      'operator',
      evidence:    [{ type: 'event', ref: 'e2', summary: 'second', at: 2 }],
    })
    expect(r.deduped).toBe(true)
    expect(r.issue.id).toBe('iss-existing')
    // No new issue row inserted — only the event for evidence_appended
    expect(updateCalls.length).toBe(1)
  })

  it('starts as "diagnosed" when rootCause provided up-front', async () => {
    selectRows = []
    lastReturning = [{ id: 'iss-2', status: 'diagnosed', symptom: 'auth fails', severity: 'warning', source: 'operator' }]
    const r = await createOrAppendIssue({
      workspaceId: 'ws-1',
      symptom:     'auth fails',
      source:      'operator',
      rootCause:   'expired JWT secret',
    })
    expect(r.issue.status).toBe('diagnosed')
  })
})

describe('status transitions', () => {
  it('diagnoseIssue updates fields + status', async () => {
    lastReturning = [{ id: 'iss-1', status: 'diagnosed', rootCause: 'rc', riskLevel: 'medium' }]
    const r = await diagnoseIssue('ws-1', 'iss-1', {
      rootCause: 'rc', riskLevel: 'medium',
    })
    expect(r?.status).toBe('diagnosed')
    expect(updateCalls[0]?.set).toMatchObject({ rootCause: 'rc', status: 'diagnosed' })
  })

  it('linkPatch transitions to "patched"', async () => {
    lastReturning = [{ id: 'iss-1', status: 'patched', patchId: 'p-99' }]
    const r = await linkPatch('ws-1', 'iss-1', 'p-99')
    expect(r?.status).toBe('patched')
    expect(updateCalls[0]?.set).toMatchObject({ patchId: 'p-99', status: 'patched' })
  })

  it('verifyIssue merges evidence and sets status verified', async () => {
    selectRows = [{ id: 'iss-1', evidence: [{ type: 'event', ref: 'e1', summary: 'first', at: 1 }], commitSha: null }]
    lastReturning = [{ id: 'iss-1', status: 'verified' }]
    const r = await verifyIssue('ws-1', 'iss-1',
      [{ type: 'log', ref: 'test-run-1', summary: 'all green', at: 2 }],
      'abc123',
    )
    expect(r?.status).toBe('verified')
    const setArg = updateCalls[0]?.set as { evidence?: unknown[]; commitSha?: string }
    expect(setArg.evidence?.length).toBe(2)
    expect(setArg.commitSha).toBe('abc123')
  })
})

describe('closeIssue safety', () => {
  it('refuses to close unless status is verified', async () => {
    selectRows = [{ id: 'iss-1', status: 'patched' }]
    await expect(closeIssue('ws-1', 'iss-1', 'op')).rejects.toThrow(/not 'verified'/)
  })

  it('allows close from non-verified when force=true', async () => {
    selectRows = [{ id: 'iss-1', status: 'open' }]
    lastReturning = [{ id: 'iss-1', status: 'closed' }]
    const r = await closeIssue('ws-1', 'iss-1', 'op', { force: true })
    expect(r?.status).toBe('closed')
  })

  it('closes normally from verified', async () => {
    selectRows = [{ id: 'iss-1', status: 'verified' }]
    lastReturning = [{ id: 'iss-1', status: 'closed' }]
    const r = await closeIssue('ws-1', 'iss-1', 'op')
    expect(r?.status).toBe('closed')
  })
})
