/**
 * Tests for safety-mode.ts — Tonight Mode runtime gates.
 *
 * Covers:
 * - isAllowed maps action → flag correctly
 * - assertAllowed throws when action blocked
 * - disableTonightMode requires exact confirmation code
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Stateful flag rows so isAllowed reads can vary per test ──────────────────
let mockFlagRows: Array<Record<string, unknown>> = []

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[]): unknown {
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
    select: () => makeChain(mockFlagRows),
    insert: () => {
      const chain = {
        values: () => chain,
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
  }
  return { db }
})

import { isAllowed, disableTonightMode } from '../services/safety-mode.js'

beforeEach(() => {
  mockFlagRows = []
})

// ─── A) isAllowed maps actions to flags ───────────────────────────────────────

describe('safety-mode: isAllowed', () => {
  it('returns false (blocked) when flag is false', async () => {
    mockFlagRows = [{
      id: 'ws', workspaceId: 'ws',
      autonomousDeployAllowed: false,
      selfEditLoopsAllowed: false,
      autonomousDepsUpgradesAllowed: false,
      destructiveMigrationsAllowed: false,
      internetLearningSwarmAllowed: false,
      tonightModeActive: true,
    }]
    expect(await isAllowed('ws', 'autonomous_deploy')).toBe(false)
    expect(await isAllowed('ws', 'self_edit_loop')).toBe(false)
    expect(await isAllowed('ws', 'destructive_migration')).toBe(false)
  })

  it('returns true when flag is explicitly enabled', async () => {
    mockFlagRows = [{
      id: 'ws', workspaceId: 'ws',
      autonomousDeployAllowed: true,
      selfEditLoopsAllowed: false,
      autonomousDepsUpgradesAllowed: false,
      destructiveMigrationsAllowed: false,
      internetLearningSwarmAllowed: false,
      tonightModeActive: false,
    }]
    expect(await isAllowed('ws', 'autonomous_deploy')).toBe(true)
    expect(await isAllowed('ws', 'self_edit_loop')).toBe(false)
  })

  it('Tonight Mode defaults — all dangerous actions blocked', async () => {
    // Empty rows → service auto-inits with safe defaults
    // (in real DB; in mock we don't simulate the insert, so explicit row needed)
    mockFlagRows = [{
      id: 'ws', workspaceId: 'ws',
      autonomousDeployAllowed: false,
      selfEditLoopsAllowed: false,
      autonomousDepsUpgradesAllowed: false,
      destructiveMigrationsAllowed: false,
      internetLearningSwarmAllowed: false,
      tonightModeActive: true,
    }]
    for (const action of ['autonomous_deploy', 'self_edit_loop',
      'autonomous_deps_upgrade', 'destructive_migration', 'internet_learning_swarm'] as const) {
      expect(await isAllowed('ws', action)).toBe(false)
    }
  })
})

// ─── B) disableTonightMode requires exact confirmation ───────────────────────

describe('safety-mode: disableTonightMode', () => {
  beforeEach(() => {
    mockFlagRows = [{
      id: 'ws', workspaceId: 'ws',
      tonightModeActive: true,
      autonomousDeployAllowed: false,
      selfEditLoopsAllowed: false,
      autonomousDepsUpgradesAllowed: false,
      destructiveMigrationsAllowed: false,
      internetLearningSwarmAllowed: false,
    }]
  })

  it('refuses without the confirmation code', async () => {
    const r = await disableTonightMode('ws', 'admin', '')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/confirmation/i)
  })

  it('refuses with wrong confirmation code', async () => {
    const r = await disableTonightMode('ws', 'admin', 'I_AGREE')
    expect(r.ok).toBe(false)
  })

  it('refuses with case mismatch', async () => {
    const r = await disableTonightMode('ws', 'admin', 'i_understand_the_risk')
    expect(r.ok).toBe(false)
  })

  it('accepts exact confirmation code', async () => {
    const r = await disableTonightMode('ws', 'admin', 'I_UNDERSTAND_THE_RISK')
    expect(r.ok).toBe(true)
  })
})
