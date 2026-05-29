/**
 * Tests for world-graph.ts — FK projection populator + neighborhood queries.
 *
 * Covers:
 *   A) populator collects edges from issues / ideas / proposals / patches
 *   B) populator dedupes within run + prunes stale edges
 *   C) neighbors returns both incoming + outgoing edges
 *   D) subgraph respects maxHops + maxPerNode bounds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let selectQueue: unknown[][] = []
const insertCalls: unknown[] = []
const deleteCalls: unknown[] = []

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
        returning: () => makeChain([]),
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
    delete: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        where: (v: unknown) => { deleteCalls.push(v); return chain },
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({
  entityRelationships: {},
  issues: {}, ideas: {}, codeProposals: {}, codePatches: {},
  businesses: {}, businessSystems: {}, incidents: {},
  connectorActions: {}, connectorAccounts: {}, events: {},
}))

import { populateWorldGraph, neighbors, subgraph } from '../services/world-graph.js'

beforeEach(() => {
  selectQueue = []
  insertCalls.length = 0
  deleteCalls.length = 0
})

describe('populateWorldGraph', () => {
  it('extracts edges from issues, ideas, proposals, patches, business_systems, actions', async () => {
    selectQueue = [
      // collectIssueEdges
      [
        { id: 'iss-1', workspaceId: 'ws-1', proposalId: 'prop-1', patchId: null,  sourceIncidentId: null,  updatedAt: 1, detectedAt: 0 },
        { id: 'iss-2', workspaceId: 'ws-1', proposalId: null,     patchId: 'pat-1', sourceIncidentId: 'inc-1', updatedAt: 2, detectedAt: 1 },
      ],
      // collectIdeaEdges
      [{ id: 'idea-1', workspaceId: 'ws-1', promotedToBusinessId: 'biz-1', promotedAt: 3, updatedAt: 3 }],
      // collectProposalEdges
      [{ id: 'prop-1', workspaceId: 'ws-1', capabilityId: 'issue:iss-1', createdAt: 0 }],
      // collectPatchEdges
      [{ id: 'pat-1', workspaceId: 'ws-1', proposalId: 'prop-1', createdAt: 0 }],
      // collectBusinessSystemEdges
      [{ id: 'sys-1', workspaceId: 'ws-1', businessId: 'biz-1', createdAt: 0 }],
      // collectConnectorActionEdges
      [{ id: 'act-1', workspaceId: 'ws-1', accountId: 'acct-1', createdAt: 0 }],
      // load existing edges (empty)
      [],
    ]
    const r = await populateWorldGraph('ws-1')
    // 7 edges expected: iss-1→prop-1, iss-2→pat-1, inc-1→iss-2,
    //                   idea-1→biz-1, prop-1→iss-1 (reciprocal), prop-1→pat-1, sys-1→biz-1, act-1→acct-1
    expect(r.inserted).toBe(8)
    expect(r.unchanged).toBe(0)
    expect(r.pruned).toBe(0)
  })

  it('dedupes within run (same source/target/relationship)', async () => {
    selectQueue = [
      [{ id: 'iss-1', workspaceId: 'ws-1', proposalId: 'prop-1', patchId: null, sourceIncidentId: null, updatedAt: 1, detectedAt: 0 }],
      [], [], [], [], [], [],
    ]
    await populateWorldGraph('ws-1')
    // Single issue with one proposalId — exactly 1 edge insert + 1 event insert
    const edgeInserts = insertCalls.filter(v => {
      const r = v as Record<string, unknown>
      return r['sourceKind'] !== undefined
    })
    expect(edgeInserts.length).toBe(1)
  })

  it('marks existing edges as unchanged + prunes stale ones', async () => {
    selectQueue = [
      [{ id: 'iss-1', workspaceId: 'ws-1', proposalId: 'prop-1', patchId: null, sourceIncidentId: null, updatedAt: 1, detectedAt: 0 }],
      [], [], [], [], [],
      // existing: one matching + one stale
      [
        { id: 'rel-1', sourceKind: 'issue', sourceId: 'iss-1', targetKind: 'proposal', targetId: 'prop-1', relationship: 'spawned-proposal' },
        { id: 'rel-stale', sourceKind: 'issue', sourceId: 'old-iss', targetKind: 'proposal', targetId: 'old-prop', relationship: 'spawned-proposal' },
      ],
    ]
    const r = await populateWorldGraph('ws-1')
    expect(r.unchanged).toBe(1)
    expect(r.pruned).toBe(1)
    expect(r.inserted).toBe(0)
  })
})

describe('neighbors', () => {
  it('returns edges touching the seed node', async () => {
    selectQueue = [[
      { sourceKind: 'issue', sourceId: 'iss-1', targetKind: 'proposal', targetId: 'prop-1', relationship: 'spawned-proposal', evidence: {}, confidence: 1, updatedAt: 1 },
      { sourceKind: 'incident', sourceId: 'inc-1', targetKind: 'issue', targetId: 'iss-1', relationship: 'triggered-issue', evidence: {}, confidence: 1, updatedAt: 2 },
    ]]
    const r = await neighbors('ws-1', 'issue', 'iss-1')
    expect(r.edges.length).toBe(2)
  })
})

describe('subgraph', () => {
  it('respects maxHops=0 (returns only seed node)', async () => {
    const r = await subgraph('ws-1', 'issue', 'iss-1', { maxHops: 0 })
    expect(r.nodes.length).toBe(1)
    expect(r.edges.length).toBe(0)
  })

  it('expands 1 hop with bounded fan-out', async () => {
    selectQueue = [[
      { sourceKind: 'issue', sourceId: 'iss-1', targetKind: 'proposal', targetId: 'prop-1', relationship: 'spawned-proposal', evidence: {}, confidence: 1, updatedAt: 1 },
      { sourceKind: 'issue', sourceId: 'iss-1', targetKind: 'patch',    targetId: 'pat-1',  relationship: 'patched-by',       evidence: {}, confidence: 1, updatedAt: 2 },
    ]]
    const r = await subgraph('ws-1', 'issue', 'iss-1', { maxHops: 1 })
    expect(r.nodes.length).toBe(3)         // iss-1 + prop-1 + pat-1
    expect(r.edges.length).toBe(2)
  })
})
