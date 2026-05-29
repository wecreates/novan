/**
 * Tests for issue-auto-loop.ts — the bridge from issues → code_proposals,
 * and the reconcile step that auto-verifies issues whose proposals ship.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { verifyIssueMock, linkProposalMock, diagnoseIssueMock } = vi.hoisted(() => ({
  verifyIssueMock:   vi.fn<(ws: string, id: string, evidence: Array<{ type: string; ref: string; summary: string; at: number }>, sha?: string) => Promise<unknown>>(async () => ({ id: 'iss-1', status: 'verified' })),
  linkProposalMock:  vi.fn<(ws: string, id: string, proposalId: string) => Promise<unknown>>(async () => ({ id: 'iss-1', proposalId: 'prop-1' })),
  // diagnoseIssue is lazily-imported inside runAutoLoopFor; the mock must
  // expose it or the dynamic import returns a module missing the export.
  diagnoseIssueMock: vi.fn<(ws: string, id: string, body: { rootCause: string; proposedFix: string; affectedSystems: string[] }) => Promise<unknown>>(async () => ({ id: 'iss-1', status: 'diagnosed' })),
}))

let selectQueue: unknown[][] = []
let lastReturning: unknown[] = []
const insertCalls: unknown[] = []

vi.mock('../db/client.js', () => {
  function makeChain(rows: unknown[]): unknown {
    const p: Promise<unknown[]> & Record<string, unknown> = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
    return new Proxy(p, {
      get(target, prop, receiver) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return Reflect.get(target, prop, receiver).bind(target)
        }
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        return () => makeChain(rows)
      },
    })
  }
  const db = {
    select: () => makeChain(selectQueue.length > 0 ? selectQueue.shift()! : []),
    insert: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        values: (v: unknown) => { insertCalls.push(v); return chain },
        returning: () => makeChain(lastReturning),
        onConflictDoNothing: () => chain,
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({ issues: {}, codeProposals: {}, events: {} }))
vi.mock('../services/issues.js', () => ({
  verifyIssue:   verifyIssueMock,
  linkProposal:  linkProposalMock,
  diagnoseIssue: diagnoseIssueMock,
}))

import {
  promoteDiagnosedIssues, reconcileShippedPatches, runAutoLoopFor,
} from '../services/issue-auto-loop.js'

beforeEach(() => {
  selectQueue = []
  lastReturning = []
  insertCalls.length = 0
  verifyIssueMock.mockClear()
  linkProposalMock.mockClear()
})

describe('promoteDiagnosedIssues', () => {
  it('returns zero counts when no diagnosed issues exist', async () => {
    selectQueue = [[]]
    const r = await promoteDiagnosedIssues('ws-1')
    expect(r).toEqual({ scanned: 0, promoted: 0, errors: 0 })
    expect(insertCalls.length).toBe(0)
  })

  it('synthesizes a proposal per diagnosed issue + calls linkProposal', async () => {
    selectQueue = [[
      {
        id: 'iss-1', workspaceId: 'ws-1', symptom: 'API 500 on /foo',
        rootCause: 'expired secret', proposedFix: 'rotate the key',
        verificationPlan: 'check 200 on /foo', affectedSystems: ['api'],
        riskLevel: 'medium', status: 'diagnosed',
      },
      {
        id: 'iss-2', workspaceId: 'ws-1', symptom: 'cron failing',
        rootCause: null, proposedFix: null, verificationPlan: null,
        affectedSystems: [], riskLevel: null, status: 'diagnosed',
      },
    ]]
    const r = await promoteDiagnosedIssues('ws-1')
    expect(r.scanned).toBe(2)
    expect(r.promoted).toBe(2)
    expect(r.errors).toBe(0)
    expect(insertCalls.length).toBe(2 + 2)   // 2 proposal inserts + 2 event emits
    expect(linkProposalMock).toHaveBeenCalledTimes(2)
    // Defaults sensibly when issue fields are sparse
    const sparseProposalInsert = insertCalls.find((v) => {
      const r = v as Record<string, unknown>
      return r['capabilityId'] === 'issue:iss-2'
    }) as Record<string, unknown>
    expect(sparseProposalInsert['riskLevel']).toBe('medium')  // default
  })
})

describe('reconcileShippedPatches', () => {
  it('returns zero counts when no patched issues exist', async () => {
    selectQueue = [[]]
    const r = await reconcileShippedPatches('ws-1')
    expect(r).toEqual({ scanned: 0, verified: 0, errors: 0 })
  })

  it('does NOT verify when proposal status is not shipped', async () => {
    selectQueue = [
      [{ id: 'iss-1', workspaceId: 'ws-1', proposalId: 'prop-1', status: 'patched' }],
      [{ id: 'prop-1', status: 'building' }],
    ]
    const r = await reconcileShippedPatches('ws-1')
    expect(r.verified).toBe(0)
    expect(verifyIssueMock).not.toHaveBeenCalled()
  })

  it('verifies issues whose linked proposal has shipped', async () => {
    selectQueue = [
      [{ id: 'iss-1', workspaceId: 'ws-1', proposalId: 'prop-1', status: 'patched' }],
      [{ id: 'prop-1', status: 'shipped', shippedCommitSha: 'abc1234567', shippedBy: 'operator', shippedAt: 1700000000 }],
    ]
    const r = await reconcileShippedPatches('ws-1')
    expect(r.verified).toBe(1)
    expect(verifyIssueMock).toHaveBeenCalledOnce()
    const args = verifyIssueMock.mock.calls[0]!
    expect(args[0]).toBe('ws-1')
    expect(args[1]).toBe('iss-1')
    const evidence = args[2] as Array<{ summary: string }>
    expect(evidence[0]!.summary).toMatch(/Proposal prop-1 shipped.*abc12345.*by operator/)
    expect(args[3]).toBe('abc1234567')
  })

  it('skips issues that have no linked proposalId', async () => {
    selectQueue = [[]]   // query already filters via isNotNull(proposalId)
    const r = await reconcileShippedPatches('ws-1')
    expect(r).toEqual({ scanned: 0, verified: 0, errors: 0 })
  })
})

describe('runAutoLoopFor', () => {
  it('runs both phases and aggregates counts', async () => {
    selectQueue = [
      [],   // promoteDiagnosedIssues — empty
      [],   // reconcileShippedPatches — empty
    ]
    const r = await runAutoLoopFor('ws-1')
    expect(r.workspaceId).toBe('ws-1')
    expect(r.promote.promoted).toBe(0)
    expect(r.reconcile.verified).toBe(0)
  })
})
