/**
 * Tests for the strategic-restraint gate in notifications.ts.
 *
 * The gate is a pre-flight check that calls shouldNotifyOperator with
 * load + dedupe context. We mock the load snapshotter + DB so we can
 * drive the decision deterministically.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

vi.mock('../db/client.js', () => {
  // Restraint context: always 0 recent + null last-ack. Strategic
  // restraint then depends on loadMode + severity alone — exactly what
  // these tests exercise. The chained select/insert/update calls all
  // resolve to []; .then and .catch are real Promises.
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

vi.mock('../services/operator-cognitive-load.js', () => {
  const state = { mode: 'normal' as 'calm' | 'normal' | 'deep' | 'overload', loadScore: 0.3 }
  ;(globalThis as { __setLoadMode?: (m: typeof state.mode, s?: number) => void }).__setLoadMode =
    (m, s) => { state.mode = m; if (s !== undefined) state.loadScore = s }
  return {
    snapshotOperatorLoad: async () => ({
      id: 'snap-1', loadScore: state.loadScore, mode: state.mode,
      recommendation: 'mock', inputs: { eventVolume: 0, alertVolume: 0, pendingCount: 0, interruptionRate: 0, windowMs: 1_800_000 },
    }),
  }
})

import { notify } from '../services/notifications.js'

// Force-materialize the operator-cognitive-load mock so `__setLoadMode`
// exists before any test runs. The mock factory only executes on first
// import, and notifications.ts imports it dynamically inside notify().
beforeAll(async () => {
  await import('../services/operator-cognitive-load.js')
})

beforeEach(() => {
  ;(globalThis as { __setLoadMode?: (m: 'normal' | 'overload' | 'deep' | 'calm') => void }).__setLoadMode?.('normal')
})

describe('notifications: shouldNotifyOperator gate', () => {
  it('suppresses normal alerts when operator is overloaded', async () => {
    ;(globalThis as { __setLoadMode?: (m: 'overload') => void }).__setLoadMode?.('overload')
    const r = await notify({
      workspaceId: 'ws_test_restraint_1',
      type: 'test.event', title: 't', body: 'b', severity: 'normal',
      signature: 'unique-1-' + Date.now(),
    })
    expect(r.suppressed).toBe(true)
    expect(r.suppressedReason).toMatch(/overload/i)
    expect(r.sent).toHaveLength(0)
  })

  it('lets critical alerts through even in overload', async () => {
    ;(globalThis as { __setLoadMode?: (m: 'overload') => void }).__setLoadMode?.('overload')
    const r = await notify({
      workspaceId: 'ws_test_restraint_2',
      type: 'test.event', title: 't', body: 'b', severity: 'critical',
      signature: 'unique-2-' + Date.now(),
    })
    expect(r.suppressed).toBeFalsy()
  })

  it('honors bypassRestraint flag', async () => {
    ;(globalThis as { __setLoadMode?: (m: 'overload') => void }).__setLoadMode?.('overload')
    const r = await notify({
      workspaceId: 'ws_test_restraint_3',
      type: 'test.event', title: 't', body: 'b', severity: 'normal',
      signature: 'unique-3-' + Date.now(),
    }, { bypassRestraint: true })
    expect(r.suppressed).toBeFalsy()
  })

  it('deep mode drops normal severity alerts', async () => {
    ;(globalThis as { __setLoadMode?: (m: 'deep') => void }).__setLoadMode?.('deep')
    const r = await notify({
      workspaceId: 'ws_test_restraint_4',
      type: 'test.event', title: 't', body: 'b', severity: 'normal',
      signature: 'unique-4-' + Date.now(),
    })
    expect(r.suppressed).toBe(true)
    expect(r.suppressedReason).toMatch(/deep/i)
  })

  it('deep mode lets high severity through', async () => {
    ;(globalThis as { __setLoadMode?: (m: 'deep') => void }).__setLoadMode?.('deep')
    const r = await notify({
      workspaceId: 'ws_test_restraint_5',
      type: 'test.event', title: 't', body: 'b', severity: 'high',
      signature: 'unique-5-' + Date.now(),
    })
    expect(r.suppressed).toBeFalsy()
  })
})
