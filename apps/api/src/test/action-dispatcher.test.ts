/**
 * Tests for action-dispatcher.ts — pure-ish dispatch behavior.
 *
 * Verifies:
 *   - risk classification per action type
 *   - high-risk requires approval token
 *   - low-risk proceeds without approval
 *
 * DB writes are best-effort (catch-and-null) so tests don't need a live DB.
 */
import { describe, it, expect, vi } from 'vitest'

// Mock db client + notifications so the service can be imported without infra.
vi.mock('../db/client.js', () => {
  const chain = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then')  return (resolve: (v: unknown) => unknown) => resolve([])
      if (prop === 'catch') return () => chain
      return () => chain
    },
  })
  return { db: { select: () => chain, insert: () => chain, update: () => chain } }
})
vi.mock('../services/notifications.js', () => ({ notify: async () => ({ sent: [], skipped: [], failed: [], rateLimited: false }) }))

import { dispatch } from '../services/action-dispatcher.js'

describe('action-dispatcher risk classification', () => {
  it('notify_operator is low risk and executes', async () => {
    const r = await dispatch({
      workspaceId: '__test_action__',
      type: 'notify_operator',
      payload: { title: 'test', body: 'test body', signature: 'test:1' },
      requestedBy: 'test-suite',
    })
    expect(r.id).toBeTruthy()
    // succeeded OR failed (no notify driver) but not pending
    expect(['succeeded', 'failed']).toContain(r.status)
  })

  it('engage_kill_switch is HIGH risk and requires approval token', async () => {
    const denied = await dispatch({
      workspaceId: '__test_action__',
      type: 'engage_kill_switch',
      payload: { switchType: 'research', reason: 'test' },   // no approvalToken
      requestedBy: 'test-suite',
    })
    expect(denied.status).toBe('pending')
    expect(denied.error).toBe('approval_required')

    const approved = await dispatch({
      workspaceId: '__test_action__',
      type: 'engage_kill_switch',
      payload: { switchType: 'research', reason: 'test', approvalToken: 'OPERATOR_APPROVED' },
      requestedBy: 'test-suite',
    })
    expect(['succeeded', 'failed']).toContain(approved.status)
  })

  it('record_decision is low risk and proceeds', async () => {
    const r = await dispatch({
      workspaceId: '__test_action__',
      type: 'record_decision',
      payload: { decision: 'test decision', confidence: 0.7 },
      requestedBy: 'test-suite',
    })
    expect(['succeeded', 'failed']).toContain(r.status)
  })

  it('cancel_pending requires actionId', async () => {
    const r = await dispatch({
      workspaceId: '__test_action__',
      type: 'cancel_pending',
      payload: {},
      requestedBy: 'test-suite',
    })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/actionId/)
  })
})
