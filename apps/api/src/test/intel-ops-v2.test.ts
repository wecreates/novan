/**
 * Tests for the three primitives shipped in the second intel-ops turn:
 *   #31 release-health scoring (pure)
 *   #42 strategic-restraint guards (pure)
 *   #32 data-governance smoke (DB-mocked — covers shape only)
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db/client.js', () => {
  const chain: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
      if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
})

import { scoreReleaseHealth } from '../services/release-health.js'
import { shouldNotifyOperator, shouldAutoAct } from '../services/strategic-restraint.js'
import { deleteWorkspaceData, exportWorkspace, inspectWorkspace } from '../services/data-governance.js'

// ─── #31 Release health ─────────────────────────────────────────────────

describe('release-health: scoreReleaseHealth', () => {
  it('clean deploy with no errors scores healthy', () => {
    const r = scoreReleaseHealth({
      deploysAttempted: 3, deploysSucceeded: 3, deploysFailed: 0, rollbacks: 0,
      postDeployErrorRate: 0.1, baselineErrorRate: 0.1,
      postDeployLatencyMs: 200, baselineLatencyMs: 200,
    })
    expect(r.verdict).toBe('healthy')
    expect(r.score).toBeGreaterThan(0.75)
  })

  it('error-rate spike drops score below healthy', () => {
    const r = scoreReleaseHealth({
      deploysAttempted: 2, deploysSucceeded: 2, deploysFailed: 0, rollbacks: 0,
      postDeployErrorRate: 5, baselineErrorRate: 1,
      postDeployLatencyMs: null, baselineLatencyMs: null,
    })
    expect(r.verdict).not.toBe('healthy')
    expect(r.reasons).toContain('error-spike')
  })

  it('rollback verdict at very low scores', () => {
    const r = scoreReleaseHealth({
      deploysAttempted: 4, deploysSucceeded: 1, deploysFailed: 3, rollbacks: 2,
      postDeployErrorRate: 10, baselineErrorRate: 1,
      postDeployLatencyMs: 1500, baselineLatencyMs: 200,
    })
    expect(r.verdict).toBe('rollback')
    expect(r.score).toBeLessThan(0.3)
  })

  it('rollback presence dings the score', () => {
    const a = scoreReleaseHealth({
      deploysAttempted: 1, deploysSucceeded: 1, deploysFailed: 0, rollbacks: 0,
      postDeployErrorRate: 0.1, baselineErrorRate: 0.1,
      postDeployLatencyMs: null, baselineLatencyMs: null,
    })
    const b = scoreReleaseHealth({
      deploysAttempted: 1, deploysSucceeded: 1, deploysFailed: 0, rollbacks: 1,
      postDeployErrorRate: 0.1, baselineErrorRate: 0.1,
      postDeployLatencyMs: null, baselineLatencyMs: null,
    })
    expect(b.score).toBeLessThan(a.score)
  })

  it('latency-drift adds a reason', () => {
    const r = scoreReleaseHealth({
      deploysAttempted: 1, deploysSucceeded: 1, deploysFailed: 0, rollbacks: 0,
      postDeployErrorRate: 0.1, baselineErrorRate: 0.1,
      postDeployLatencyMs: 600, baselineLatencyMs: 200,
    })
    expect(r.reasons).toContain('latency-drift')
  })

  it('zero deploys defaults to healthy', () => {
    const r = scoreReleaseHealth({
      deploysAttempted: 0, deploysSucceeded: 0, deploysFailed: 0, rollbacks: 0,
      postDeployErrorRate: 0, baselineErrorRate: 0,
      postDeployLatencyMs: null, baselineLatencyMs: null,
    })
    expect(r.verdict).toBe('healthy')
  })
})

// ─── #42 Strategic restraint ────────────────────────────────────────────

describe('restraint: shouldNotifyOperator', () => {
  const base = { loadScore: 0.2, loadMode: 'normal' as const, recentNotifications: 0, msSinceLastAck: 0, duplicateSignature: false }

  it('critical alerts always fire (unless duplicate)', () => {
    const r = shouldNotifyOperator('critical', base)
    expect(r.allow).toBe(true)
  })

  it('duplicate critical is suppressed for a window', () => {
    const r = shouldNotifyOperator('critical', { ...base, duplicateSignature: true })
    expect(r.allow).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
  })

  it('overload suppresses non-critical alerts', () => {
    expect(shouldNotifyOperator('high',   { ...base, loadMode: 'overload' }).allow).toBe(false)
    expect(shouldNotifyOperator('normal', { ...base, loadMode: 'overload' }).allow).toBe(false)
    expect(shouldNotifyOperator('critical', { ...base, loadMode: 'overload' }).allow).toBe(true)
  })

  it('deep mode drops normal but allows high', () => {
    expect(shouldNotifyOperator('normal', { ...base, loadMode: 'deep' }).allow).toBe(false)
    expect(shouldNotifyOperator('high',   { ...base, loadMode: 'deep' }).allow).toBe(true)
  })

  it('alert fatigue downgrades severity', () => {
    const r = shouldNotifyOperator('high', { ...base, recentNotifications: 15, msSinceLastAck: 60 * 60_000 })
    expect(r.allow).toBe(true)                       // high still gets through
    expect(r.suggestedSeverity).toBe('normal')        // but downgraded
    const r2 = shouldNotifyOperator('normal', { ...base, recentNotifications: 15, msSinceLastAck: 60 * 60_000 })
    expect(r2.allow).toBe(false)                     // normal blocked
  })

  it('duplicate signature blocks even in normal mode', () => {
    const r = shouldNotifyOperator('high', { ...base, duplicateSignature: true })
    expect(r.allow).toBe(false)
  })
})

describe('restraint: shouldAutoAct', () => {
  const base = { risk: 'low' as const, hardBlocked: false, budgetBlocked: false, loadMode: 'normal' as const, trustedPattern: false, handsFreeEnabled: false }

  it('hard-blocked plans always reject', () => {
    const r = shouldAutoAct({ ...base, hardBlocked: true })
    expect(r.allow).toBe(false)
    expect(r.deferTo).toBe('reject')
  })

  it('budget-blocked plans always reject', () => {
    const r = shouldAutoAct({ ...base, budgetBlocked: true })
    expect(r.deferTo).toBe('reject')
  })

  it('high-risk plans always require dry-run', () => {
    const r = shouldAutoAct({ ...base, risk: 'high' })
    expect(r.allow).toBe(false)
    expect(r.deferTo).toBe('dry_run')
  })

  it('medium-risk defers to dry-run by default', () => {
    const r = shouldAutoAct({ ...base, risk: 'medium' })
    expect(r.deferTo).toBe('dry_run')
  })

  it('medium-risk trusted pattern under hands-free can execute', () => {
    const r = shouldAutoAct({ ...base, risk: 'medium', trustedPattern: true, handsFreeEnabled: true })
    expect(r.allow).toBe(true)
    expect(r.deferTo).toBe('execute')
  })

  it('overload defers even low-risk automation', () => {
    const r = shouldAutoAct({ ...base, loadMode: 'overload' })
    expect(r.allow).toBe(false)
    expect(r.deferTo).toBe('operator')
  })

  it('low-risk in normal load executes', () => {
    expect(shouldAutoAct(base).allow).toBe(true)
  })

  it('hard-block beats trusted-pattern + hands-free', () => {
    const r = shouldAutoAct({ ...base, hardBlocked: true, trustedPattern: true, handsFreeEnabled: true })
    expect(r.deferTo).toBe('reject')
  })
})

// ─── #32 Data governance — refusal paths ────────────────────────────────

describe('data-governance: refusal paths', () => {
  it('delete without confirm is refused', async () => {
    const r = await deleteWorkspaceData({ workspaceId: 'ws', confirm: false, reason: 'whatever' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/confirm/)
  })

  it('delete without an adequate reason is refused', async () => {
    const r = await deleteWorkspaceData({ workspaceId: 'ws', confirm: true, reason: 'no' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/reason/)
  })

  it('inspect returns a summary array shape (empty under mock)', async () => {
    const rows = await inspectWorkspace('ws-x')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.every(r => 'scope' in r && 'rowCount' in r)).toBe(true)
  })

  it('export returns a bundle with rowCounts + retention', async () => {
    const bundle = await exportWorkspace('ws-x')
    expect(bundle.workspaceId).toBe('ws-x')
    expect(bundle).toHaveProperty('rowCounts')
    expect(bundle).toHaveProperty('retention')
    expect(bundle.retention).toHaveProperty('voice_events')
  })
})
