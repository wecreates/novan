/**
 * Tests for chat-intent.ts — pure pattern detection.
 */
import { describe, it, expect } from 'vitest'
import { detectIntents } from '../services/chat-intent.js'

describe('chat-intent: build_proposal', () => {
  it('detects "build a proposal for X"', () => {
    const r = detectIntents('Build a proposal for a social media scheduler with X and LinkedIn support')
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.actionType).toBe('build_proposal')
    expect(r[0]!.riskLevel).toBe('low')
  })
  it('detects "create a feature that posts"', () => {
    const r = detectIntents('Create a feature that automates inventory tracking for Etsy')
    expect(r.some(a => a.actionType === 'build_proposal')).toBe(true)
  })
  it('does NOT match casual mentions', () => {
    const r = detectIntents('that proposal looks fine')
    expect(r.find(a => a.actionType === 'build_proposal')).toBeUndefined()
  })
})

describe('chat-intent: throttle_queue', () => {
  it('detects "throttle ai queue"', () => {
    const r = detectIntents('Throttle the ai queue to 0.3')
    expect(r[0]!.actionType).toBe('throttle_queue')
    expect(r[0]!.payload.queue).toBe('ai')
    expect(r[0]!.payload.factor).toBe(0.3)
    expect(r[0]!.riskLevel).toBe('medium')
  })
  it('detects "slow down browser"', () => {
    const r = detectIntents('Slow down the browser queue')
    expect(r[0]!.actionType).toBe('throttle_queue')
    expect(r[0]!.payload.queue).toBe('browser')
  })
})

describe('chat-intent: swap_provider', () => {
  it('detects swap with known providers', () => {
    const r = detectIntents('Swap from openai to groq for chat')
    expect(r[0]!.actionType).toBe('swap_provider_recommendation')
    expect(r[0]!.payload.from).toBe('openai')
    expect(r[0]!.payload.to).toBe('groq')
  })
  it('rejects swap to unknown provider', () => {
    const r = detectIntents('Switch from groq to acmellm')
    expect(r.find(a => a.actionType === 'swap_provider_recommendation')).toBeUndefined()
  })
})

describe('chat-intent: kill switch (CRITICAL)', () => {
  it('detects engage kill switch as critical risk', () => {
    const r = detectIntents('Engage the kill switch for research')
    expect(r[0]!.actionType).toBe('engage_kill_switch')
    expect(r[0]!.riskLevel).toBe('critical')
  })
  it('detects "activate kill switch"', () => {
    const r = detectIntents('Activate the killswitch on research immediately')
    expect(r[0]!.actionType).toBe('engage_kill_switch')
  })
})

describe('chat-intent: pause_agent', () => {
  it('detects pause agent', () => {
    const r = detectIntents('Pause the social-publisher agent')
    expect(r[0]!.actionType).toBe('pause_agent')
    expect(r[0]!.payload.agentName).toBe('social-publisher')
  })
  it('rejects "stop it" without agent name', () => {
    const r = detectIntents('Stop it')
    expect(r.find(a => a.actionType === 'pause_agent')).toBeUndefined()
  })
})

describe('chat-intent: set_horizon', () => {
  it('detects "set horizon: reach $10k MRR"', () => {
    const r = detectIntents('Set 90d horizon: reach $10k MRR by end of quarter')
    expect(r[0]!.actionType).toBe('set_horizon')
    expect(r[0]!.payload.horizon).toBe('90d')
  })
  it('defaults to 90d if unspecified', () => {
    const r = detectIntents('Create a horizon to ship 5 new products in next quarter')
    if (r[0]?.actionType === 'set_horizon') {
      expect(r[0].payload.horizon).toBe('90d')
    }
  })
})

describe('chat-intent: record_decision', () => {
  it('detects record decision', () => {
    const r = detectIntents('Record a decision: switching primary provider to groq for cost reasons')
    expect(r[0]!.actionType).toBe('record_decision')
  })
})

describe('chat-intent: dedup + cap', () => {
  it('caps at 3 suggestions per message', () => {
    const txt = `Build a proposal for an X scheduler. Throttle the ai queue. Engage the kill switch. Pause the social-publisher agent. Set 90d horizon: do X.`
    const r = detectIntents(txt)
    expect(r.length).toBeLessThanOrEqual(3)
  })
  it('deduplicates identical suggestions', () => {
    const txt = 'Throttle the ai queue. Throttle the ai queue.'
    const r = detectIntents(txt)
    expect(r.filter(a => a.actionType === 'throttle_queue').length).toBe(1)
  })
})

describe('chat-intent: pure (no I/O)', () => {
  it('empty text returns no suggestions', () => {
    expect(detectIntents('')).toEqual([])
    expect(detectIntents('hi')).toEqual([])
  })
  it('benign chitchat returns no suggestions', () => {
    const r = detectIntents('what is our current uptime')
    expect(r).toEqual([])
  })
})
