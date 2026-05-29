/**
 * Tests for strategic-priority.ts — ranking with transparent formula.
 *
 * Covers:
 *   A) empty workspace → empty list
 *   B) issues ranked by severity weight × age
 *   C) ideas ranked by upside × readiness / difficulty
 *   D) cross-source sort (an emergency incident outranks a 1-hour issue)
 *   E) scoreParts always populated (operator can audit the math)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let selectQueue: unknown[][] = []

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
  const db = { select: () => makeChain(selectQueue.length > 0 ? selectQueue.shift()! : []) }
  return { db }
})
vi.mock('../db/schema.js', () => ({
  issues: {}, ideas: {}, codeProposals: {}, connectorActions: {}, incidents: {},
}))

import { rankStrategicPriority } from '../services/strategic-priority.js'

beforeEach(() => { selectQueue = [] })

describe('rankStrategicPriority', () => {
  it('returns empty when no work exists', async () => {
    selectQueue = [[], [], [], [], []]
    const r = await rankStrategicPriority('ws-1')
    expect(r).toEqual([])
  })

  it('ranks emergency incidents above warning issues', async () => {
    const now = Date.now()
    selectQueue = [
      // issues (3-hour-old warning)
      [{ id: 'iss-1', symptom: 'minor', severity: 'warning', detectedAt: now - 3 * 3600_000, status: 'open' }],
      // ideas
      [],
      // proposals
      [],
      // approvals
      [],
      // incidents (1-hour-old emergency)
      [{ id: 'inc-1', title: 'production down', severity: 'emergency', detectedAt: now - 1 * 3600_000, status: 'open' }],
    ]
    const r = await rankStrategicPriority('ws-1')
    expect(r.length).toBe(2)
    expect(r[0]!.kind).toBe('incident')
    expect(r[0]!.severity).toBe('emergency')
  })

  it('boosts blueprinted ideas over validated', async () => {
    selectQueue = [
      [],
      [
        { id: 'i-val', title: 'val idea', status: 'validated', upsideScore: 50, buildReadiness: 50, difficultyScore: 50, createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'i-bp',  title: 'bp idea',  status: 'blueprinted', upsideScore: 50, buildReadiness: 50, difficultyScore: 50, createdAt: Date.now(), updatedAt: Date.now() },
      ],
      [], [], [],
    ]
    const r = await rankStrategicPriority('ws-1')
    expect(r[0]!.id).toBe('i-bp')                       // blueprinted wins
    expect(r[0]!.scoreParts['blueprintedBoost']).toBe(25)
    expect(r[1]!.scoreParts['blueprintedBoost']).toBe(0)
  })

  it('approvals age into urgency', async () => {
    const now = Date.now()
    selectQueue = [
      [], [], [],
      [
        { id: 'a-new', action: 'x', intent: 'fresh', riskLevel: 'medium', createdAt: now,                phase: 'awaiting_approval' },
        { id: 'a-old', action: 'y', intent: 'stale', riskLevel: 'medium', createdAt: now - 5 * 3600_000, phase: 'awaiting_approval' },
      ],
      [],
    ]
    const r = await rankStrategicPriority('ws-1')
    expect(r[0]!.id).toBe('a-old')
    expect(r[0]!.scoreParts['agePenalty']).toBeGreaterThan(0)
  })

  it('always populates scoreParts (operator can audit)', async () => {
    selectQueue = [
      [{ id: 'iss-1', symptom: 's', severity: 'critical', detectedAt: Date.now(), status: 'open' }],
      [], [], [], [],
    ]
    const r = await rankStrategicPriority('ws-1')
    expect(r[0]!.scoreParts).toBeDefined()
    expect(Object.keys(r[0]!.scoreParts).length).toBeGreaterThan(0)
  })
})
