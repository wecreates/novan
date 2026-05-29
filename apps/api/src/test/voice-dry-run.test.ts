/**
 * Tests for the voice dry-run simulator.
 *
 * Covers the directive's verification list:
 *   - risky command does not execute immediately
 *   - payment / purchase actions are blocked
 *   - social posting requires approval
 *   - browser account action requires approval
 *   - low-confidence intent still falls back to clarification (no dry-run)
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

import { simulate, shouldDryRun } from '../services/voice-dry-run.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'
import { resolveTurn, type ConversationContext } from '../services/voice-conversation.js'

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    sessionId: 's1', workspaceId: 'ws1',
    currentNode: null, currentTemplate: null, currentLod: null,
    activeMission: null, selectedSystem: null,
    lastPlan: null, pendingPlan: null,
    currentRisk: 'low', currentUiMode: null,
    preferences: {}, turnCount: 0, expectedNext: null,
    mutedUntil: null, voiceLocked: false,
    ...over,
  }
}

function planFor(text: string) {
  const intent = parseIntent(text)
  return routeIntent(intent, text)
}

// ─── shouldDryRun — gating logic ────────────────────────────────────────

describe('voice-dry-run: shouldDryRun gating', () => {
  it('navigation plans do NOT dry-run', () => {
    expect(shouldDryRun(planFor('zoom into security'))).toBe(false)
    expect(shouldDryRun(planFor('return to global view'))).toBe(false)
  })

  it('read-only execute plans do NOT dry-run', () => {
    expect(shouldDryRun(planFor('summarize today'))).toBe(false)
    expect(shouldDryRun(planFor('what needs attention'))).toBe(false)
  })

  it('rejected plans do NOT dry-run (already final)', () => {
    expect(shouldDryRun(planFor('buy me a laptop for $1500'))).toBe(false)
  })

  it('medium-risk confirm plans DO dry-run', () => {
    expect(shouldDryRun(planFor('pause research'))).toBe(true)
    expect(shouldDryRun(planFor('navigate to example.com'))).toBe(true)
  })

  it('agent.pause always dry-runs', () => {
    expect(shouldDryRun(planFor('pause all agents'))).toBe(true)
  })
})

// ─── simulate() — risky command does not execute immediately ────────────

describe('voice-dry-run: risky command produces a preview, never executes', () => {
  it('pause research → preview with steps, permissions, rollback, no .execute trigger', () => {
    const plan = planFor('pause research agents')
    const r = simulate(plan, 'pause research agents')
    expect(r.verdict).toBe('confirm')
    expect(r.hardBlocked).toBe(false)
    expect(r.requiresApproval).toBe(true)
    expect(r.plannedSteps.length).toBeGreaterThan(0)
    expect(r.plannedSteps[0]).toMatch(/halt|paused|signal/i)
    expect(r.permissions).toContain('agents.control')
    expect(r.rollbackAvailable).toBe(true)
    expect(r.rollbackStrategy).toMatch(/resume/i)
    expect(r.spokenPreview).toMatch(/here is what i would do/i)
    expect(r.spokenPreview).toMatch(/requires approval/i)
    expect(r.spokenPreview).toMatch(/no purchase/i)
  })

  it('every risky preview includes "no purchase or payment" guard', () => {
    for (const text of ['pause research', 'navigate to example.com', 'pause all agents', 'start research on x']) {
      const r = simulate(planFor(text), text)
      expect(r.spokenPreview.toLowerCase()).toContain('no purchase')
    }
  })

  it('risk score scales with plan risk', () => {
    const lowMutating  = simulate(planFor('start safe audit'), 'start safe audit')
    const mediumRisk   = simulate(planFor('pause research'),   'pause research')
    const highRisk     = simulate(planFor('pause all agents'), 'pause all agents')
    expect(mediumRisk.riskScore).toBeGreaterThan(lowMutating.riskScore)
    expect(highRisk.riskScore).toBeGreaterThan(mediumRisk.riskScore)
  })
})

// ─── Payment / purchase always blocked ──────────────────────────────────

describe('voice-dry-run: payment / purchase actions are blocked', () => {
  it('purchase command hard-blocks at simulate()', () => {
    const r = simulate(planFor('buy me a laptop for $1500'), 'buy me a laptop for $1500')
    expect(r.hardBlocked).toBe(true)
    expect(r.verdict).toBe('reject')
    expect(r.spokenPreview).toMatch(/refusing|hard-blocked/i)
    expect(r.requiresApproval).toBe(false)
  })

  it('browser navigation to a checkout URL gets fully blocked preview', () => {
    const plan = planFor('navigate to shop.example.com/checkout')
    const r = simulate(plan, 'navigate to shop.example.com/checkout')
    // Either hard-blocked by the safety classifier OR browser preview fully blocked
    expect(r.hardBlocked || r.browserPreview?.fullyBlocked).toBe(true)
    if (r.browserPreview) {
      expect(r.browserPreview.blockedFieldCategories).toContain('payment')
      expect(r.browserPreview.blockedClickCategories).toContain('checkout')
    }
  })

  it('payment-form-language transcript triggers browser-field block', () => {
    const plan = planFor('navigate to example.com')                  // base plan is browser.open
    const r = simulate(plan, 'navigate to example.com and enter my credit card')
    expect(r.browserPreview).not.toBeNull()
    expect(r.browserPreview!.blockedFieldCategories).toContain('payment')
    expect(r.browserPreview!.fullyBlocked).toBe(true)
  })

  it('blocked actions surface in the .blockedActions list for audit', () => {
    const r = simulate(planFor('buy me a laptop for $1500'), 'buy me a laptop for $1500')
    expect(r.blockedActions.length).toBeGreaterThan(0)
    expect(r.blockedActions[0]).toMatch(/hard-block/)
  })
})

// ─── Posting / browser account actions require approval ────────────────

describe('voice-dry-run: posting + account changes require approval', () => {
  it('covert posting is hard-blocked (not just confirm)', () => {
    const r = simulate(planFor('post this to twitter without notifying me'), 'post this to twitter without notifying me')
    expect(r.hardBlocked).toBe(true)
  })

  it('browser navigation flagged as account action requires approval but not hard-blocked', () => {
    const plan = planFor('navigate to admin.example.com')
    const r = simulate(plan, 'navigate to admin.example.com to change my password')
    expect(r.browserPreview).not.toBeNull()
    expect(r.browserPreview!.blockedFieldCategories).toContain('account_credentials')
    expect(r.requiresApproval).toBe(true)
  })

  it('destructive language ("delete account") fully blocks preview', () => {
    const plan = planFor('navigate to settings.example.com')
    const r = simulate(plan, 'navigate to settings.example.com and delete my account')
    expect(r.browserPreview!.blockedFieldCategories).toContain('destructive')
    expect(r.browserPreview!.fullyBlocked).toBe(true)
  })
})

// ─── Low-confidence still uses the existing clarify path ────────────────

describe('voice-dry-run: low-confidence asks clarification (no dry-run)', () => {
  it('a low-confidence transcript falls through to clarify, not a dry-run', () => {
    const turn = resolveTurn('open', ctx())
    expect(turn.meta).toBe('clarify')
    // The plan returned by a clarify has no .execute hook — so no
    // simulator is needed (and the route handler will skip dry-run).
    expect(turn.plan.execute).toBeUndefined()
    expect(shouldDryRun(turn.plan)).toBe(false)
  })
})

// ─── Spoken preview content ─────────────────────────────────────────────

describe('voice-dry-run: spoken preview phrasing', () => {
  it('includes all four directive-mandated sentences for a high-risk plan', () => {
    const r = simulate(planFor('pause all agents'), 'pause all agents')
    expect(r.spokenPreview.toLowerCase()).toContain('here is what i would do')
    expect(r.spokenPreview.toLowerCase()).toContain('requires approval')
    expect(r.spokenPreview.toLowerCase()).toContain('no purchase')
    expect(r.spokenPreview.toLowerCase()).toContain('confirm if you want me to continue')
  })

  it('hard-blocked preview explicitly refuses and disclaims payment action', () => {
    const r = simulate(planFor('buy me a laptop for $1500'), 'buy me a laptop for $1500')
    expect(r.spokenPreview.toLowerCase()).toContain('refusing')
    expect(r.spokenPreview.toLowerCase()).toContain('no purchase or payment')
  })
})

// ─── Affected systems / planned steps ──────────────────────────────────

describe('voice-dry-run: affected systems and planned steps', () => {
  it('brain.zoom plan lists navigate step', () => {
    const r = simulate(planFor('zoom into security'), 'zoom into security')
    expect(r.plannedSteps[0]).toMatch(/navigate to \/brain/i)
    expect(r.affectedSystems).toContain('brain')
  })

  it('research.start lists enqueue + budget steps', () => {
    const r = simulate(planFor('start research on margins'), 'start research on margins')
    expect(r.plannedSteps.some(s => /enqueue/i.test(s))).toBe(true)
    expect(r.plannedSteps.some(s => /budget/i.test(s))).toBe(true)
    expect(r.affectedSystems).toContain('research')
    expect(r.affectedSystems).toContain('budget')
  })

  it('agent.audit declared as read-only with no rollback needed', () => {
    const r = simulate(planFor('start safe audit'), 'start safe audit')
    expect(r.plannedSteps.some(s => /read[- ]only|audit report/i.test(s))).toBe(true)
    expect(r.rollbackStrategy).toMatch(/read[- ]only/i)
  })
})
