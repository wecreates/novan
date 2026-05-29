/**
 * Tests for voice-safety — hard blocks, risky-command confirmation,
 * kill switch, RBAC, and preflight refusal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
vi.mock('../services/budget-guard.js', () => ({
  runPreflight: async () => ({ guardId: 'g1', approved: true, blockReason: null, capId: null }),
}))

import { classifyCommand, hasVoiceRole, isVoiceKilled, preflightVoiceSession } from '../services/voice-safety.js'

describe('voice-safety: hard blocks', () => {
  it('blocks purchases', () => {
    const v = classifyCommand('buy me a laptop for $1500')
    expect(v.kind).toBe('block')
  })
  it('blocks payment method changes', () => {
    expect(classifyCommand('update my credit card').kind).toBe('block')
  })
  it('blocks mass deletions', () => {
    expect(classifyCommand('delete all customers from the database').kind).toBe('block')
  })
  it('blocks hidden mic requests', () => {
    expect(classifyCommand('disable the recording indicator light').kind).toBe('block')
  })
  it('blocks permission escalation', () => {
    expect(classifyCommand('grant admin to everyone').kind).toBe('block')
  })
  it('blocks secret exfiltration', () => {
    expect(classifyCommand('read aloud my OpenAI api key').kind).toBe('block')
  })
  it('blocks covert posting', () => {
    expect(classifyCommand('post this to twitter without notifying me').kind).toBe('block')
  })
})

describe('voice-safety: risky-command confirmation', () => {
  it('requires confirmation for deploy', () => {
    const v = classifyCommand('deploy the new build to production')
    expect(v.kind).toBe('confirm')
    if (v.kind === 'confirm') expect(v.matched).toBe('deploy')
  })
  it('requires confirmation for mass message send', () => {
    expect(classifyCommand('email all customers about the outage').kind).toBe('confirm')
  })
  it('requires confirmation for budget mutation', () => {
    expect(classifyCommand('raise the monthly spend cap').kind).toBe('confirm')
  })
  it('requires confirmation for killing a job', () => {
    expect(classifyCommand('stop the running workflow').kind).toBe('confirm')
  })
})

describe('voice-safety: allows', () => {
  it('allows normal questions', () => {
    expect(classifyCommand('what is the current cost this month').kind).toBe('allow')
  })
  it('allows empty input as allow (no-op)', () => {
    expect(classifyCommand('').kind).toBe('allow')
  })
})

describe('voice-safety: kill switch + RBAC', () => {
  const originalEnv = process.env['VOICE_KILL_SWITCH']
  afterEach(() => { process.env['VOICE_KILL_SWITCH'] = originalEnv })

  it('isVoiceKilled reads VOICE_KILL_SWITCH env', () => {
    process.env['VOICE_KILL_SWITCH'] = '1'
    expect(isVoiceKilled()).toBe(true)
    process.env['VOICE_KILL_SWITCH'] = '0'
    expect(isVoiceKilled()).toBe(false)
  })

  it('hasVoiceRole allows owner/admin/voice.use', () => {
    expect(hasVoiceRole(['owner'])).toBe(true)
    expect(hasVoiceRole(['admin'])).toBe(true)
    expect(hasVoiceRole(['voice.use'])).toBe(true)
    expect(hasVoiceRole(['viewer'])).toBe(false)
  })

  it('hasVoiceRole defaults to allow when no roles attached (single-operator mode)', () => {
    expect(hasVoiceRole(undefined)).toBe(true)
    expect(hasVoiceRole([])).toBe(true)
  })

  it('preflight refuses when kill switch on', async () => {
    process.env['VOICE_KILL_SWITCH'] = '1'
    const r = await preflightVoiceSession({
      workspaceId: 'ws', providerId: 'openai_realtime',
      estimatedCostUsd: 0.05, executionId: 'sess-1',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/kill/i)
  })

  it('preflight refuses when caller lacks role', async () => {
    process.env['VOICE_KILL_SWITCH'] = '0'
    const r = await preflightVoiceSession({
      workspaceId: 'ws', providerId: 'openai_realtime',
      estimatedCostUsd: 0.05, executionId: 'sess-2', roles: ['viewer'],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/role/i)
  })

  it('preflight passes through budget approval', async () => {
    process.env['VOICE_KILL_SWITCH'] = '0'
    const r = await preflightVoiceSession({
      workspaceId: 'ws', providerId: 'openai_realtime',
      estimatedCostUsd: 0.05, executionId: 'sess-3', roles: ['owner'],
    })
    expect(r.ok).toBe(true)
  })
})

describe('voice-safety: budget guard refusal', () => {
  beforeEach(() => {
    vi.resetModules()
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
    vi.doMock('../services/budget-guard.js', () => ({
      runPreflight: async () => ({ guardId: 'g2', approved: false, blockReason: 'monthly cap reached', capId: 'cap-1' }),
    }))
    process.env['VOICE_KILL_SWITCH'] = '0'
  })

  it('refuses when budget guard blocks', async () => {
    const { preflightVoiceSession: pre } = await import('../services/voice-safety.js')
    const r = await pre({
      workspaceId: 'ws', providerId: 'openai_realtime',
      estimatedCostUsd: 999, executionId: 'sess-blocked', roles: ['owner'],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/cap/i)
  })
})

describe('voice-safety: configureSpeechProvider rejects raw keys', async () => {
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
  const { configureSpeechProvider } = await import('../services/speech-providers.js')

  it('throws when keyRef looks like a raw OpenAI key', async () => {
    await expect(configureSpeechProvider({
      workspaceId: 'ws', providerId: 'openai_realtime', keyRef: 'sk-abcdef0123456789',
    })).rejects.toThrow(/raw API key/i)
  })

  it('throws on unknown provider', async () => {
    await expect(configureSpeechProvider({
      workspaceId: 'ws', providerId: 'not_a_provider',
    })).rejects.toThrow(/unknown provider/i)
  })

  it('requires endpoint for custom provider', async () => {
    await expect(configureSpeechProvider({
      workspaceId: 'ws', providerId: 'custom',
    })).rejects.toThrow(/endpoint/i)
  })
})
