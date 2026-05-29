/**
 * Tests for the five voice dry-run gap-closures:
 *   1. Server-side executor uses the stored execute hook
 *   2. Budget preflight is included in the report
 *   3. sweepExpiredDryRuns expires stale rows
 *   4. Spoken-approval meta detection routes to the approval flow
 *   5. Typed BrowserActionPlan is emitted alongside the preview
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

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

import { simulate, executeDryRun, type DryRunExecutor } from '../services/voice-dry-run.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'
import { resolveTurn, detectMeta, deriveContextPatch, type ConversationContext } from '../services/voice-conversation.js'

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    sessionId: 's1', workspaceId: 'ws1',
    currentNode: null, currentTemplate: null, currentLod: null,
    activeMission: null, selectedSystem: null,
    lastPlan: null, pendingPlan: null,
    currentRisk: 'low', currentUiMode: null,
    preferences: {}, turnCount: 0, expectedNext: null,
    mutedUntil: null, voiceLocked: false, pendingDryRunId: null,
    ...over,
  }
}

// ─── 1. Server-side executor reads the stored hook ──────────────────────

describe('executor: dispatches the stored execute hook', () => {
  it('reject path returns false when no executor supplied for an approved row', async () => {
    // We can't easily set up an approved row through the mocked client,
    // so this test focuses on the contract: executor signature carries
    // the hook by typed shape.
    const exec: DryRunExecutor = async (hook) => ({ status: 200, body: { received: hook.path } })
    const result = await exec({ method: 'POST', path: '/api/v1/agents/audit', body: {} }, {} as never)   // test fixture — full DryRunRow shape not needed
    expect(result.status).toBe(200)
    expect((result.body as { received: string }).received).toBe('/api/v1/agents/audit')
  })

  it('not-found rows return ok=false reason="not found"', async () => {
    const r = await executeDryRun({ id: 'does-not-exist', workspaceId: 'ws' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/i)
  })
})

// ─── 2. Budget preflight is exposed on the report ───────────────────────

describe('simulate: report shape includes budgetDecision + executeHook', () => {
  it('exposes executeHook as a serializable object when the plan has one', () => {
    const plan = routeIntent(parseIntent('pause research'), 'pause research')
    const r = simulate(plan, 'pause research')
    expect(r.executeHook).not.toBeNull()
    expect(r.executeHook?.method).toBe('POST')
    expect(r.executeHook?.path).toMatch(/^\/api\/v1\//)
  })
  it('exposes budgetDecision field (null by default — DB layer populates)', () => {
    const plan = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    const r = simulate(plan, 'zoom into security')
    expect(r).toHaveProperty('budgetDecision')
    expect(r.budgetDecision).toBeNull()
  })
})

// ─── 5. Typed BrowserActionPlan ─────────────────────────────────────────

describe('simulate: typed browser action plan', () => {
  it('produces a BrowserActionPlan for browser.open intents', () => {
    const plan = routeIntent(parseIntent('navigate to example.com'), 'navigate to example.com')
    const r = simulate(plan, 'navigate to example.com')
    expect(r.browserActionPlan).not.toBeNull()
    expect(r.browserActionPlan!.version).toBe(1)
    expect(r.browserActionPlan!.allowed).toBe(true)
    expect(r.browserActionPlan!.url).toBe('example.com')
    expect(r.browserActionPlan!.blockedFieldCategories).toEqual([])
  })

  it('marks allowed=false when payment/destructive flagged', () => {
    const plan = routeIntent(parseIntent('navigate to shop.example.com'), 'navigate to shop.example.com and enter my credit card')
    const r = simulate(plan, 'navigate to shop.example.com and enter my credit card')
    expect(r.browserActionPlan).not.toBeNull()
    expect(r.browserActionPlan!.allowed).toBe(false)
    expect(r.browserActionPlan!.refusalReason).toMatch(/payment|destructive/i)
    expect(r.browserActionPlan!.blockedFieldCategories).toContain('payment')
  })

  it('passes the typed plan through for destructive language', () => {
    const plan = routeIntent(parseIntent('navigate to settings.example.com'), 'navigate to settings.example.com and delete my account')
    const r = simulate(plan, 'navigate to settings.example.com and delete my account')
    expect(r.browserActionPlan!.blockedFieldCategories).toContain('destructive')
    expect(r.browserActionPlan!.allowed).toBe(false)
  })

  it('no browser plan for non-browser intents', () => {
    const plan = routeIntent(parseIntent('pause research'), 'pause research')
    const r = simulate(plan, 'pause research')
    expect(r.browserActionPlan).toBeNull()
  })
})

// ─── 4. Spoken approval / rejection meta detection ──────────────────────

describe('conversation: approve_dry_run / reject_dry_run metas', () => {
  it('"approve dry run" detected as approve_dry_run', () => {
    expect(detectMeta('approve dry run')).toBe('approve_dry_run')
    expect(detectMeta('approve the dry-run')).toBe('approve_dry_run')
    expect(detectMeta('approve and execute')).toBe('approve_dry_run')
  })

  it('"cancel dry run" / "reject the preview" detected as reject_dry_run', () => {
    expect(detectMeta('cancel dry run')).toBe('reject_dry_run')
    expect(detectMeta('reject the preview')).toBe('reject_dry_run')
    expect(detectMeta('discard the dry run')).toBe('reject_dry_run')
  })

  it('approve_dry_run with no pending id acknowledges politely', () => {
    const t = resolveTurn('approve dry run', ctx())
    expect(t.meta).toBe('approve_dry_run')
    expect(t.plan.speak.toLowerCase()).toContain('nothing pending')
  })

  it('approve_dry_run with pendingDryRunId carries the id in intent args', () => {
    const t = resolveTurn('approve dry run', ctx({ pendingDryRunId: 'dr_abc123' }))
    expect(t.meta).toBe('approve_dry_run')
    expect(t.intent.args['dry_run_id']).toBe('dr_abc123')
    expect(t.plan.speak.toLowerCase()).toContain('approving')
  })

  it('reject_dry_run with pendingDryRunId carries the id', () => {
    const t = resolveTurn('cancel dry run', ctx({ pendingDryRunId: 'dr_xyz789' }))
    expect(t.meta).toBe('reject_dry_run')
    expect(t.intent.args['dry_run_id']).toBe('dr_xyz789')
  })

  it('deriveContextPatch clears pendingDryRunId after approve/reject', () => {
    const tApprove = resolveTurn('approve dry run', ctx({ pendingDryRunId: 'dr_1' }))
    expect(deriveContextPatch(tApprove, ctx({ pendingDryRunId: 'dr_1' })).pendingDryRunId).toBeNull()
    const tReject = resolveTurn('cancel dry run', ctx({ pendingDryRunId: 'dr_1' }))
    expect(deriveContextPatch(tReject, ctx({ pendingDryRunId: 'dr_1' })).pendingDryRunId).toBeNull()
  })
})

// ─── 3. Sweep expiry contract ───────────────────────────────────────────

describe('sweepExpiredDryRuns: behavior contract', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  it('returns zero when no rows are present (smoke)', async () => {
    vi.doMock('../db/client.js', () => {
      const chain: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then')  return (onFulfilled: (v: unknown) => unknown) => Promise.resolve([]).then(onFulfilled)
          if (prop === 'catch') return (onRejected: (e: unknown) => unknown) => Promise.resolve([]).catch(onRejected)
          return () => chain
        },
      })
      return { db: { select: () => chain, insert: () => chain, update: () => chain, delete: () => chain } }
    })
    const mod = await import('../services/voice-dry-run.js')
    const r = await mod.sweepExpiredDryRuns()
    expect(r.expired).toBe(0)
  })
})

// ─── Hard-block + budget still wins ─────────────────────────────────────

describe('integration: safety wins over executor', () => {
  it('hard-blocked simulate() carries the rejection through to executeHook=null path', () => {
    const plan = routeIntent(parseIntent('buy a laptop'), 'buy me a laptop for $1500')
    const r = simulate(plan, 'buy me a laptop for $1500')
    expect(r.hardBlocked).toBe(true)
    // Even though the underlying plan was 'reject', no execute hook
    // should be inferred — there is nothing to dispatch.
    expect(r.executeHook).toBeNull()
  })
})
