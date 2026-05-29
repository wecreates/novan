/**
 * Tests for connectors.ts — registry + action runtime pipeline.
 *
 * Covers:
 *   A) isHardBlocked matches purchase/payment/banking patterns
 *   B) dispatchAction phases: blocked / awaiting_approval / failed (no handler)
 *   C) Connector-level blocked_actions hard-stop
 *   D) Permission tier enforcement
 *   E) Scope enforcement
 *   F) Approval flow runs handler when approved
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let selectRows: unknown[] = []
let lastReturning: unknown[] = []
const insertCalls: unknown[] = []
const updateCalls: Array<{ set: unknown }> = []

// Mock select chain — supports the call site looking up account by id,
// then connector by id, then (separately) action row by id.
let selectQueue: unknown[][] = []
function nextSelectRows(): unknown[] {
  if (selectQueue.length > 0) return selectQueue.shift()!
  return selectRows
}

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
    select: () => makeChain(nextSelectRows()),
    insert: () => {
      const chain = {
        values: (v: unknown) => { insertCalls.push(v); return chain },
        returning: () => makeChain(lastReturning),
        onConflictDoNothing: () => chain,
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      // The chain must be thenable (so `await db.update().set().where()` resolves)
      // AND offer `.returning()`, `.catch()`, and `.where()` post-where.
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        set: (v: unknown) => { updateCalls.push({ set: v }); return chain },
        where: () => chain,
        returning: () => makeChain(lastReturning),
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      })
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({
  connectors: {}, connectorAccounts: {}, connectorActions: {}, events: {}, secretsVault: {},
  connectorKillSwitches: {}, connectorRateLimits: {},
}))
vi.mock('../services/secrets-vault.js', () => ({
  revealSecret: vi.fn(async () => 'fake-secret-value'),
}))

import {
  isHardBlocked, dispatchAction, approveAction,
  registerActionDescriptor, registerActionHandler,
} from '../services/connectors.js'

beforeEach(() => {
  selectRows = []
  selectQueue = []
  lastReturning = []
  insertCalls.length = 0
  updateCalls.length = 0
})

// ── A. Hard-block patterns ────────────────────────────────────────────

describe('isHardBlocked', () => {
  it('matches purchase / payment / banking intents', () => {
    expect(isHardBlocked('purchase laptop')).toBe(true)
    expect(isHardBlocked('checkout now')).toBe(true)
    expect(isHardBlocked('enter card details')).toBe(true)
    expect(isHardBlocked('wire transfer to vendor')).toBe(true)
    expect(isHardBlocked('send crypto to address')).toBe(true)
    expect(isHardBlocked('delete account')).toBe(true)
  })

  it('does not match benign intents', () => {
    expect(isHardBlocked('create issue')).toBe(false)
    expect(isHardBlocked('list channels')).toBe(false)
    expect(isHardBlocked('subscribe newsletter')).toBe(false)
  })
})

// ── B / C / D / E. dispatchAction pipeline ────────────────────────────

describe('dispatchAction', () => {
  beforeEach(() => {
    registerActionDescriptor('test.low_read', { risk: 'low', minPermission: 'read' })
    registerActionDescriptor('test.draft_medium', { risk: 'medium', minPermission: 'draft' })
    registerActionDescriptor('test.publish_high', { risk: 'high', minPermission: 'publish', requiredScopes: ['scope_a'] })
  })

  it('returns failed when account is missing', async () => {
    selectQueue = [[], []]   // kill_switch lookup, then account lookup — both empty
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'missing', action: 'test.low_read', intent: 'read', params: {},
    })
    expect(r.phase).toBe('failed')
    expect(r.error).toMatch(/account not found/)
  })

  // Helper — prefix queue with kill-switch + rate-limit-no-op rows.
  // Sequence: [kill_switch, account, connector_for_category, rate_overrides, rate_count, ...rest]
  function qWithPrefix(account: unknown, connector: unknown, ...rest: unknown[][]): unknown[][] {
    return [
      [],                  // kill switch — empty = not blocked
      [account],
      [connector],         // for category check
      [],                  // rate-limit overrides — none
      [{ c: 0 }],          // rate-limit count — 0 hits
      ...rest,
    ]
  }

  it('blocks when account status is not active', async () => {
    selectQueue = [
      [],                  // kill switch
      [{ id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'paused', permission: 'admin', grantedScopes: [] }],
    ]
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.low_read', intent: 'read', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/paused/)
  })

  it('blocks hard-block intents at policy stage', async () => {
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.low_read'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.low_read',
      intent: 'please purchase a new laptop',     // intent triggers hard-block
      params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/permanently blocked/)
  })

  it('blocks connector-level blocked_actions', async () => {
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.low_read', 'test.danger'], blockedActions: ['test.danger'] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.danger', intent: 'do the thing', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/blocked at connector level/)
  })

  it('blocks when permission tier is insufficient', async () => {
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'read', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.draft_medium'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.draft_medium', intent: 'draft thing', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/permission.*read.*draft/)
  })

  it('blocks when required scopes are missing', async () => {
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: ['scope_b'] },
      { id: 'test', category: 'developer', supportedActions: ['test.publish_high'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.publish_high', intent: 'publish', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/missing OAuth scopes.*scope_a/)
  })

  it('routes medium-risk actions to awaiting_approval', async () => {
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'draft', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.draft_medium'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.draft_medium', intent: 'draft thing', params: { x: 1 },
    })
    expect(r.phase).toBe('awaiting_approval')
    expect(r.awaitingApproval).toBe(true)
    expect(r.dryRunPreview?.summary).toBeDefined()
  })

  it('returns failed with helpful error when no handler is wired', async () => {
    registerActionDescriptor('test.unwired', { risk: 'low', minPermission: 'read' })
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.unwired'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.unwired', intent: 'do', params: {},
    })
    expect(r.phase).toBe('failed')
    expect(r.error).toMatch(/handler not implemented/)
  })

  it('executes low-risk action when handler is wired', async () => {
    registerActionDescriptor('test.handled', { risk: 'low', minPermission: 'read' })
    registerActionHandler('test.handled', { handler: async () => ({ ok: true, value: 42 }) })
    selectQueue = qWithPrefix(
      { id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] },
      { id: 'test', category: 'developer', supportedActions: ['test.handled'], blockedActions: [] },
    )
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.handled', intent: 'do', params: {},
    })
    expect(r.phase).toBe('completed')
    expect(r.result).toEqual({ ok: true, value: 42 })
  })

  // ── Kill switch + rate limiting ───────────────────────────────────

  it('kill switch all_blocked stops dispatch immediately', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', allBlocked: true, categoryBlocked: [], connectorBlocked: [], reason: 'maintenance' }],
    ]
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.low_read', intent: 'read', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/all connector actions paused/)
  })

  it('kill switch connectorBlocked stops only that connector', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', allBlocked: false, categoryBlocked: [], connectorBlocked: ['test'], reason: null }],
      [{ id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] }],
    ]
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.low_read', intent: 'read', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/connector 'test' paused/)
  })

  it('kill switch categoryBlocked stops the whole category', async () => {
    selectQueue = [
      [{ workspaceId: 'ws-1', allBlocked: false, categoryBlocked: ['commerce'], connectorBlocked: [], reason: null }],
      [{ id: 'a1', workspaceId: 'ws-1', connectorId: 'shopify', status: 'active', permission: 'admin', grantedScopes: [] }],
      [{ id: 'shopify', category: 'commerce', supportedActions: ['shopify.list'], blockedActions: [] }],
    ]
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'shopify.list', intent: 'list', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/category 'commerce' paused/)
  })

  it('rate limit blocks when 60s window exceeds default', async () => {
    selectQueue = [
      [],                                          // kill switch
      [{ id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'admin', grantedScopes: [] }],
      [{ id: 'test', category: 'developer', supportedActions: ['test.low_read'], blockedActions: [] }],
      [],                                          // rate-limit overrides — use default
      [{ c: 100 }],                                // already 100 hits — over the 60/min default
    ]
    const r = await dispatchAction({
      workspaceId: 'ws-1', accountId: 'a1', action: 'test.low_read', intent: 'read', params: {},
    })
    expect(r.phase).toBe('blocked')
    expect(r.blockedReason).toMatch(/rate_limit.*100\/60/)
  })
})

// ── F. Approval flow ─────────────────────────────────────────────────

describe('approveAction', () => {
  it('runs handler when approved + transitions to completed', async () => {
    registerActionDescriptor('test.approved_path', { risk: 'medium', minPermission: 'draft' })
    registerActionHandler('test.approved_path', { handler: async () => ({ approved: true }) })

    // approveAction lookup sequence:
    //   1. action row
    //   2. account
    //   3. connector
    // (does NOT re-run kill/rate-limit checks — those already fired on initial dispatch)
    selectQueue = [
      [{
        id: 'act-1', workspaceId: 'ws-1', accountId: 'a1', action: 'test.approved_path',
        intent: 'do', params: {}, phase: 'awaiting_approval', riskLevel: 'medium',
        dryRunPreview: null,
      }],
      [{ id: 'a1', workspaceId: 'ws-1', connectorId: 'test', status: 'active', permission: 'draft', grantedScopes: [] }],
      [{ id: 'test', category: 'developer', supportedActions: ['test.approved_path'], blockedActions: [] }],
    ]
    const r = await approveAction('ws-1', 'act-1', 'operator-1')
    expect(r.phase).toBe('completed')
    expect(r.result).toEqual({ approved: true })
  })

  it('refuses to approve when action is not awaiting_approval', async () => {
    selectQueue = [
      [{ id: 'act-1', workspaceId: 'ws-1', accountId: 'a1', action: 'x', phase: 'completed' }],
    ]
    const r = await approveAction('ws-1', 'act-1', 'op')
    expect(r.phase).toBe('completed')   // returns its current phase
    expect(r.error).toMatch(/cannot approve/)
  })
})
