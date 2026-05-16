/**
 * Tests for rbac.ts — role-based access control.
 *
 * Covers:
 * - PERMISSIONS catalog has the documented entries
 * - PROTECTED_ACTIONS set lists high-impact perms
 * - authorize() denies when no permission record exists
 * - authorize() denies when grants array doesn't include the permission
 * - authorize() allows when grants array contains the permission
 * - authorizeOrThrow throws on denial
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockPermRows: Array<{ role: string; grants: string[] }> = []
const auditInserts: unknown[] = []

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = []): unknown {
    return new Proxy(
      { _isChain: true },
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(returnValue)
          if (prop === 'catch') return () => makeChain(returnValue)
          if (typeof prop === 'symbol') return undefined
          return () => makeChain(returnValue)
        },
      },
    )
  }
  const db = {
    select: () => makeChain(mockPermRows),
    insert: () => {
      const chain = {
        values: (v: unknown) => { auditInserts.push(v); return chain },
        onConflictDoNothing: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: () => chain,
        where: () => chain,
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
  authorize, authorizeOrThrow,
  PERMISSIONS, PROTECTED_ACTIONS,
}                          from '../services/rbac.js'

beforeEach(() => {
  mockPermRows = []
  auditInserts.length = 0
})

// ─── A) PERMISSIONS catalog ──────────────────────────────────────────────────

describe('rbac: PERMISSIONS catalog', () => {
  it('has core workspace permissions', () => {
    expect(PERMISSIONS.WORKSPACE_VIEW).toBe('workspace.view')
    expect(PERMISSIONS.WORKSPACE_EDIT).toBe('workspace.edit')
    expect(PERMISSIONS.WORKSPACE_DELETE).toBe('workspace.delete')
  })

  it('has billing permissions', () => {
    expect(PERMISSIONS.BILLING_VIEW).toBe('billing.view')
    expect(PERMISSIONS.BILLING_MANAGE).toBe('billing.manage')
    expect(PERMISSIONS.PLAN_CHANGE).toBe('plan.change')
  })

  it('has runtime control permissions', () => {
    expect(PERMISSIONS.WORKFLOW_RUN).toBe('workflow.run')
    expect(PERMISSIONS.WORKFLOW_PAUSE).toBe('workflow.pause')
    expect(PERMISSIONS.AGENT_CONTROL).toBe('agent.control')
    expect(PERMISSIONS.REPLAY_TRIGGER).toBe('replay.trigger')
    expect(PERMISSIONS.ROLLBACK_TRIGGER).toBe('rollback.trigger')
  })

  it('has secret + audit permissions', () => {
    expect(PERMISSIONS.SECRET_REVEAL).toBe('secret.reveal')
    expect(PERMISSIONS.SECRET_ROTATE).toBe('secret.rotate')
    expect(PERMISSIONS.AUDIT_EXPORT).toBe('audit.export')
  })

  it('every PERMISSIONS value is a non-empty string', () => {
    for (const v of Object.values(PERMISSIONS)) {
      expect(typeof v).toBe('string')
      expect(v.length).toBeGreaterThan(0)
    }
  })
})

// ─── B) PROTECTED_ACTIONS set ────────────────────────────────────────────────

describe('rbac: PROTECTED_ACTIONS', () => {
  it('protects high-impact actions', () => {
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.WORKSPACE_DELETE)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.BILLING_MANAGE)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.PLAN_CHANGE)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.DEPLOY_TRIGGER)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.LAUNCH_OVERRIDE)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.SECRET_REVEAL)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.ROLLBACK_TRIGGER)).toBe(true)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.AUDIT_EXPORT)).toBe(true)
  })

  it('does NOT protect benign read actions', () => {
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.WORKSPACE_VIEW)).toBe(false)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.AUDIT_VIEW)).toBe(false)
    expect(PROTECTED_ACTIONS.has(PERMISSIONS.BILLING_VIEW)).toBe(false)
  })
})

// ─── C) authorize() — denial paths ───────────────────────────────────────────

describe('rbac: authorize denial paths', () => {
  it('denies when no permission record exists for user', async () => {
    mockPermRows = []
    const r = await authorize('alice', 'ws-1', PERMISSIONS.WORKFLOW_RUN)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/no permission record/i)
  })

  it('denies when role exists but grants array lacks the permission', async () => {
    mockPermRows = [{ role: 'viewer', grants: ['workspace.view'] }]
    const r = await authorize('alice', 'ws-1', PERMISSIONS.WORKFLOW_RUN)
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/lacks permission/i)
    expect(r.role).toBe('viewer')
  })

  it('records an audit row for every denial', async () => {
    mockPermRows = []
    await authorize('alice', 'ws-1', PERMISSIONS.SECRET_REVEAL)
    // service writes to both securityAudits and events on deny
    expect(auditInserts.length).toBeGreaterThanOrEqual(1)
  })
})

// ─── D) authorize() — allow paths ────────────────────────────────────────────

describe('rbac: authorize allow paths', () => {
  it('allows when grants array includes the permission', async () => {
    mockPermRows = [{
      role: 'admin',
      grants: ['workspace.view', 'workflow.run', 'workflow.pause'],
    }]
    const r = await authorize('alice', 'ws-1', PERMISSIONS.WORKFLOW_RUN)
    expect(r.allowed).toBe(true)
    expect(r.role).toBe('admin')
  })

  it('owner role with all permissions allows protected actions', async () => {
    mockPermRows = [{
      role: 'owner',
      grants: Object.values(PERMISSIONS),
    }]
    const r = await authorize('alice', 'ws-1', PERMISSIONS.SECRET_REVEAL)
    expect(r.allowed).toBe(true)
  })
})

// ─── E) authorizeOrThrow ─────────────────────────────────────────────────────

describe('rbac: authorizeOrThrow', () => {
  it('throws when denied', async () => {
    mockPermRows = []
    await expect(
      authorizeOrThrow('alice', 'ws-1', PERMISSIONS.WORKFLOW_RUN),
    ).rejects.toThrow(/permission denied/i)
  })

  it('returns role when allowed', async () => {
    mockPermRows = [{ role: 'member', grants: ['workflow.run'] }]
    const role = await authorizeOrThrow('alice', 'ws-1', PERMISSIONS.WORKFLOW_RUN)
    expect(role).toBe('member')
  })
})
