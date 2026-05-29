/**
 * policy-engine.test.ts — verifies the declarative governance rule
 * evaluator. Concrete cases because these rules gate every risky op.
 */
import { describe, it, expect } from 'vitest'
import { evaluate, listRules, _addRuleForTest, type PolicyContext } from '../services/policy-engine.js'

function ctx(p: Partial<PolicyContext>): PolicyContext {
  return {
    op: 'test.op', risk: 'low', workspaceId: 'ws-1', caller: 'operator',
    params: {}, ...p,
  }
}

describe('policy-engine basic verdicts', () => {
  it('default allows a low-risk operator call', () => {
    const d = evaluate(ctx({ op: 'portfolio.list', risk: 'low' }))
    expect(d.verdict).toBe('allow')
  })

  it('critical-risk without approval is denied', () => {
    const d = evaluate(ctx({ op: 'business.delete', risk: 'critical' }))
    expect(d.verdict).toBe('deny')
    expect(d.matchedRules.some(r => r.id === 'critical_requires_approval')).toBe(true)
  })

  it('critical-risk with OPERATOR_APPROVED is allowed', () => {
    const d = evaluate(ctx({ op: 'business.delete', risk: 'critical', approvalToken: 'OPERATOR_APPROVED' }))
    expect(d.verdict).toBe('allow')
  })

  it('high-risk without approval → require_approval (not deny)', () => {
    const d = evaluate(ctx({ op: 'portfolio.improve', risk: 'high' }))
    expect(d.verdict).toBe('require_approval')
  })
})

describe('policy-engine money-pattern guard', () => {
  it('blocks money pattern from non-operator caller even with token', () => {
    const d = evaluate(ctx({
      op: 'payments.charge', risk: 'high', moneyPatternDetected: true,
      caller: 'agent', approvalToken: 'OPERATOR_APPROVED',
    }))
    expect(d.verdict).toBe('deny')
    expect(d.matchedRules.some(r => r.id === 'money_pattern_hard_block')).toBe(true)
  })

  it('allows money pattern from operator with token', () => {
    const d = evaluate(ctx({
      op: 'payments.charge', risk: 'high', moneyPatternDetected: true,
      caller: 'operator', approvalToken: 'OPERATOR_APPROVED',
    }))
    expect(d.verdict).toBe('allow')
  })
})

describe('policy-engine spend caps', () => {
  it('denies non-operator calls when daily spend exceeds $50', () => {
    const d = evaluate(ctx({
      op: 'agent.dispatch', risk: 'low', caller: 'agent',
      telemetry: { todaySpendUsd: 75 },
    }))
    expect(d.verdict).toBe('deny')
    expect(d.matchedRules.some(r => r.id === 'daily_spend_cap')).toBe(true)
  })

  it('still allows operator calls past the daily cap', () => {
    const d = evaluate(ctx({
      op: 'portfolio.list', risk: 'low', caller: 'operator',
      telemetry: { todaySpendUsd: 75 },
    }))
    expect(d.verdict).toBe('allow')
  })

  it('weekly cap denies at $250 for non-operator', () => {
    const d = evaluate(ctx({
      op: 'agent.dispatch', risk: 'low', caller: 'cron',
      telemetry: { weekSpendUsd: 250 },
    }))
    expect(d.verdict).toBe('deny')
    expect(d.matchedRules.some(r => r.id === 'weekly_spend_cap')).toBe(true)
  })
})

describe('policy-engine agent quiet hours', () => {
  it('community_manager at 23:00 UTC → require_approval', () => {
    const d = evaluate(ctx({
      op: 'community.reply', risk: 'low', caller: 'agent',
      agentPersona: 'community_manager',
      telemetry: { nowIso: '2026-05-27T23:30:00Z' },
    }))
    expect(d.verdict).toBe('require_approval')
  })

  it('community_manager at 14:00 UTC → allow', () => {
    const d = evaluate(ctx({
      op: 'community.reply', risk: 'low', caller: 'agent',
      agentPersona: 'community_manager',
      telemetry: { nowIso: '2026-05-27T14:00:00Z' },
    }))
    expect(d.verdict).toBe('allow')
  })

  it('other personas at 23:00 UTC are unaffected by this rule', () => {
    const d = evaluate(ctx({
      op: 'agent.dispatch', risk: 'low', caller: 'agent',
      agentPersona: 'trend_hunter',
      telemetry: { nowIso: '2026-05-27T23:30:00Z' },
    }))
    expect(d.verdict).toBe('allow')
  })
})

describe('policy-engine MCP + cron + circuit-break rules', () => {
  it('MCP call at risk=medium requires approval', () => {
    const d = evaluate(ctx({ op: 'business.feasibility', risk: 'medium', caller: 'mcp' }))
    expect(d.verdict).toBe('require_approval')
  })

  it('MCP call at risk=low is allowed', () => {
    const d = evaluate(ctx({ op: 'portfolio.list', risk: 'low', caller: 'mcp' }))
    expect(d.verdict).toBe('allow')
  })

  it('cron cannot execute destructive ops', () => {
    const d = evaluate(ctx({ op: 'business.delete', risk: 'high', caller: 'cron' }))
    expect(d.verdict).toBe('deny')
  })

  it('repeated denies → circuit break', () => {
    const d = evaluate(ctx({
      op: 'agent.dispatch', risk: 'low', caller: 'agent',
      telemetry: { recentDenies: 15 },
    }))
    expect(d.verdict).toBe('deny')
    expect(d.matchedRules.some(r => r.id === 'repeated_denies_circuit_break')).toBe(true)
  })
})

describe('policy-engine strict-wins precedence', () => {
  it('deny wins over allow even if a higher-priority rule allowed', () => {
    // Add a temporary rule that says allow; the critical_requires_approval
    // rule should still deny (deny > allow regardless of order).
    const cleanup = _addRuleForTest({
      id: 'test_always_allow', description: 'test', priority: 10_000,
      evaluate: () => 'allow' as const,
    })
    try {
      const d = evaluate(ctx({ op: 'business.delete', risk: 'critical' }))
      expect(d.verdict).toBe('deny')
    } finally {
      cleanup()
    }
  })

  it('require_approval wins over allow', () => {
    const cleanup1 = _addRuleForTest({ id: 't_allow', description: 'test', evaluate: () => 'allow' as const })
    const cleanup2 = _addRuleForTest({ id: 't_approve', description: 'test', evaluate: () => 'require_approval' as const })
    try {
      const d = evaluate(ctx({ op: 'something', risk: 'low' }))
      expect(d.verdict).toBe('require_approval')
    } finally {
      cleanup1(); cleanup2()
    }
  })
})

describe('policy-engine listRules', () => {
  it('exposes the rule catalog for the governance UI', () => {
    const rules = listRules()
    expect(rules.length).toBeGreaterThanOrEqual(8)
    expect(rules.some(r => r.id === 'money_pattern_hard_block')).toBe(true)
    // Sorted by priority desc
    for (let i = 1; i < rules.length; i++) {
      expect((rules[i - 1]!.priority ?? 100)).toBeGreaterThanOrEqual(rules[i]!.priority ?? 100)
    }
  })
})
