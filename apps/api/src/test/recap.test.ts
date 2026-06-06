/**
 * Tests for recap.ts — aggregator over events + issues + ideas + actions.
 *
 * Covers:
 *   A) headline composition
 *   B) acknowledgeRecap resets boundary
 *   C) generateRecap returns structured sections with real DB rows
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let selectQueue: unknown[][] = []
const updateCalls: Array<{ set: unknown }> = []
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
        // R146.199 — recap.ts now uses .onConflictDoNothing({target}) on
        // the operator_presence upsert. R146.220 — also onConflictDoUpdate
        // in some callers; expose both as no-op chains.
        onConflictDoNothing: () => chain,
        onConflictDoUpdate: () => chain,
        returning: () => makeChain([]),
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
    update: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        set: (v: unknown) => { updateCalls.push({ set: v }); return chain },
        where: () => chain,
        returning: () => makeChain([]),
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({
  events: {}, issues: {}, ideas: {}, incidents: {},
  connectorActions: {}, operatorPresence: {}, codeProposals: {},
}))

import { generateRecap, acknowledgeRecap } from '../services/recap.js'

beforeEach(() => {
  selectQueue = []
  updateCalls.length = 0
  insertCalls.length = 0
})

describe('generateRecap', () => {
  it('returns hasContent=false when all sections are empty', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', operatorId: 'default', lastSeenAt: Date.now() - 60_000 }], // presence
      [], [], [],            // improvements: verified issues, promoted ideas, autoloop events
      [], [],                // active: pendingApprovals, in-flight proposals (both empty)
      [], [], [],            // alerts: incidents, cron errors, blocked
      [],                    // opportunities: ideas
      [],                    // learning: ingest events
    ]
    const r = await generateRecap('ws-1')
    expect(r.hasContent).toBe(false)
    expect(r.headline).toMatch(/Quiet/)
  })

  it('aggregates verified issues into improvements', async () => {
    const past = Date.now() - 3 * 3600_000
    selectQueue = [
      [{ workspaceId: 'ws-1', operatorId: 'default', lastSeenAt: past - 60_000 }],
      [
        { id: 'iss-1', symptom: 'API 500 on /foo', status: 'verified', updatedAt: past + 1000 },
        { id: 'iss-2', symptom: 'cron failed', status: 'closed',    updatedAt: past + 2000 },
      ],
      [], [],                // promoted ideas, autoloop events
      [], [],                // pendingApprovals, in-flight proposals
      [], [], [],            // alerts queries
      [],                    // opportunities
      [],                    // learning
    ]
    const r = await generateRecap('ws-1')
    expect(r.improvements.length).toBe(2)
    expect(r.improvements[0]!.label).toMatch(/(Verified|Closed):/)
    expect(r.hasContent).toBe(true)
  })

  it('groups cron.error events by task instead of flooding', async () => {
    const past = Date.now() - 1000
    selectQueue = [
      [{ workspaceId: 'ws-1', operatorId: 'default', lastSeenAt: past - 60_000 }],
      [], [], [],
      [], [],
      [],                    // incidents
      [                      // 5 cron errors, all same task
        { payload: { task: 'incident', error: 'pg down' }, createdAt: past + 1, id: 'e1' },
        { payload: { task: 'incident', error: 'pg down' }, createdAt: past + 2, id: 'e2' },
        { payload: { task: 'incident', error: 'pg down' }, createdAt: past + 3, id: 'e3' },
        { payload: { task: 'incident', error: 'pg down' }, createdAt: past + 4, id: 'e4' },
        { payload: { task: 'incident', error: 'pg down' }, createdAt: past + 5, id: 'e5' },
      ],
      [],                    // blocked actions
      [],                    // opportunities
      [],                    // learning
    ]
    const r = await generateRecap('ws-1')
    expect(r.alerts.length).toBe(1)            // 5 grouped into 1
    expect(r.alerts[0]!.label).toMatch(/×5/)
  })

  it('returns pending approvals count in counts', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', operatorId: 'default', lastSeenAt: 0 }],
      [], [], [],
      [
        { id: 'act-1', action: 'github.create_issue', intent: 'file the bug', createdAt: Date.now() },
        { id: 'act-2', action: 'slack.post_message',  intent: 'announce',     createdAt: Date.now() },
      ],
      [],
      [], [], [],
      [],
      [],
    ]
    const r = await generateRecap('ws-1')
    expect(r.counts.pendingApprovals).toBe(2)
    expect(r.headline).toMatch(/2 approvals pending/)
  })
})

describe('acknowledgeRecap', () => {
  it('writes lastSeenAt + lastPolledAt and emits event', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', operatorId: 'default', lastSeenAt: 0 }], // getOrInitPresence
    ]
    await acknowledgeRecap('ws-1')
    expect(updateCalls.length).toBeGreaterThanOrEqual(1)
    const set = updateCalls[0]!.set as Record<string, unknown>
    expect(set['lastSeenAt']).toBeDefined()
    expect(set['lastPolledAt']).toBeDefined()
    // Event was emitted
    const eventInsert = insertCalls.find(v => {
      const r = v as Record<string, unknown>
      return r['type'] === 'recap.acknowledged'
    })
    expect(eventInsert).toBeTruthy()
  })
})
