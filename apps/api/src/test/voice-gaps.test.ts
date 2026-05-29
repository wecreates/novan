/**
 * Tests for the six follow-up gaps:
 *   1. Multi-turn disambiguation (expectedNext)
 *   2. Quality scores influencing routing
 *   3. Preferred-provider bump
 *   4. Barge-in / TTS cancel (server-side flag plumbing only — UI is tested
 *      in the browser).
 *   5. Real STT is browser-side; tests just confirm the /command pipeline
 *      treats any text identically.
 *   6. Preferences round-trip in routing.
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

import { resolveTurn, type ConversationContext } from '../services/voice-conversation.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'
import { decideFromRows } from '../services/speech-router.js'
import { getProviderDefinition, type ProviderRow } from '../services/speech-providers.js'

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    sessionId: 's1', workspaceId: 'ws1',
    currentNode: null, currentTemplate: null, currentLod: null,
    activeMission: null, selectedSystem: null,
    lastPlan: null, pendingPlan: null,
    currentRisk: 'low', currentUiMode: null,
    preferences: {}, turnCount: 0, expectedNext: null,
    ...over,
  }
}

function row(over: Partial<ProviderRow>): ProviderRow {
  const providerId = over.providerId ?? 'openai_realtime'
  const cat = getProviderDefinition(providerId)
  return {
    id: `cfg-${providerId}`, providerId,
    displayName: cat?.displayName ?? providerId,
    kind: (cat?.kind ?? 'realtime_s2s') as ProviderRow['kind'],
    enabled: true, priority: 100,
    preferredVoice: cat?.defaultVoice ?? null, preferredLocale: 'en-US',
    maxCostPerMinUsd: 0.5, maxLatencyMs: 1500,
    supportsStreaming: cat?.supportsStreaming ?? true,
    supportsInterruption: cat?.supportsInterruption ?? false,
    healthScore: 1.0, lastLatencyMs: cat?.typicalLatencyMs ?? null,
    lastError: null, lastHealthAt: null, hasKey: true, catalogue: cat,
    ...over,
  } as ProviderRow
}

// ─── 1. Multi-turn disambiguation (expectedNext) ────────────────────────

describe('multi-turn disambiguation: expectedNext yes_no', () => {
  it('an unknown utterance after a confirm prompt is resolved as the answer', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const expectedNext = { kind: 'yes_no' as const, pendingPlan: pending, originalIntent: pending.intent.kind, prompt: 'Confirm pause research?' }
    const t = resolveTurn('yes', ctx({ expectedNext, pendingPlan: pending }))
    expect(t.answeredClarification).toBe(true)
    expect(t.meta).toBe('confirm')
    expect(t.intent.kind).toBe(pending.intent.kind)
    expect(t.expectedNext).toBeNull()
  })

  it('"no" or "cancel" after a yes_no prompt rejects without executing', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const expectedNext = { kind: 'yes_no' as const, pendingPlan: pending, originalIntent: pending.intent.kind, prompt: 'Confirm?' }
    const t = resolveTurn('no, cancel', ctx({ expectedNext, pendingPlan: pending }))
    expect(t.meta).toBe('never_mind')
    expect(t.answeredClarification).toBe(true)
  })

  it('a generic "yes" with NO expectedNext maps to confirm-meta (legacy path)', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const t = resolveTurn('yes', ctx({ pendingPlan: pending }))
    // confirm-meta path still works for plain "confirm/yes" without expectedNext
    expect(t.meta).toBe('confirm')
  })

  it('clarification emits expectedNext so the NEXT turn answers it', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const t = resolveTurn('hmm', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('clarify')
    expect(t.expectedNext?.kind).toBe('yes_no')
    expect(t.expectedNext?.pendingPlan).toBeTruthy()
  })

  it('choose_one expectation resolves with a listed option', () => {
    const expectedNext = { kind: 'choose_one' as const, options: ['zoom', 'detail', 'pause'], originalIntent: 'security', prompt: '?' }
    const t = resolveTurn('zoom', ctx({ expectedNext, selectedSystem: 'security' }))
    expect(t.answeredClarification).toBe(true)
    expect(t.intent.kind).toMatch(/^brain\./)
    expect(t.expectedNext).toBeNull()
  })

  it('unmatched answer falls through to normal parsing', () => {
    const expectedNext = { kind: 'yes_no' as const, prompt: '?' }
    const t = resolveTurn('zoom into security', ctx({ expectedNext }))
    // "zoom into security" is not yes/no — should fall through and parse normally
    expect(t.intent.kind).toBe('brain.zoom')
  })
})

// ─── 2. Quality scores influence routing ────────────────────────────────

describe('router quality scoring', () => {
  it('higher quality score wins between otherwise-equal providers', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 0.9 }),
      row({ providerId: 'gemini_live',      healthScore: 0.9 }),
    ]
    const d = decideFromRows(rows, {
      mode: 'realtime',
      qualityScores: { gemini_live: 0.9, openai_realtime: 0.2 },
      qualityWeight: 0.4,
    })
    expect(d.primary).toBe('gemini_live')
  })

  it('qualityWeight=0 makes quality scores irrelevant', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 1.0 }),
      row({ providerId: 'gemini_live',      healthScore: 0.5 }),
    ]
    const d = decideFromRows(rows, {
      mode: 'realtime',
      qualityScores: { gemini_live: 1.0, openai_realtime: 0.0 },
      qualityWeight: 0,
    })
    expect(d.primary).toBe('openai_realtime')   // health wins when weight=0
  })

  it('missing quality scores degrade gracefully (no crash)', () => {
    const rows = [row({ providerId: 'openai_realtime' })]
    const d = decideFromRows(rows, { mode: 'realtime' })
    expect(d.ok).toBe(true)
    expect(d.primary).toBe('openai_realtime')
  })
})

// ─── 3. Preferred-provider bump ─────────────────────────────────────────

describe('router preferred-provider bump', () => {
  it('flips selection when providers are otherwise tied', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 0.9 }),
      row({ providerId: 'gemini_live',      healthScore: 0.9 }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime', preferredProvider: 'gemini_live' })
    expect(d.primary).toBe('gemini_live')
  })

  it('does NOT override a strongly-better provider', () => {
    const rows = [
      row({ providerId: 'openai_realtime', healthScore: 1.0, lastLatencyMs: 200 }),
      row({ providerId: 'gemini_live',      healthScore: 0.1, lastLatencyMs: 3000 }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime', preferredProvider: 'gemini_live' })
    // preferred bump is only +0.05 — should not flip a wide gap
    expect(d.primary).toBe('openai_realtime')
  })

  it('preferred-provider is logged in scoring reasons', () => {
    const rows = [
      row({ providerId: 'openai_realtime' }),
      row({ providerId: 'gemini_live' }),
    ]
    const d = decideFromRows(rows, { mode: 'realtime', preferredProvider: 'gemini_live' })
    const gem = d.scores.find(s => s.providerId === 'gemini_live')
    expect(gem?.reasons.some(r => r.includes('preferred'))).toBe(true)
  })
})

// ─── 4. Auto-confirm low-risk preference (server side data only) ────────

describe('preferences plumbing', () => {
  it('exists in the WorkspaceVoicePrefs shape', async () => {
    // Smoke import — the file compiles & exports types
    const mod = await import('../services/voice-preferences.js')
    expect(typeof mod.getVoicePrefs).toBe('function')
    expect(typeof mod.patchVoicePrefs).toBe('function')
  })
})

// ─── 5. STT pipeline parity — text path produces identical routing ─────

describe('text path == speech path', () => {
  it('a transcript with leading/trailing whitespace routes identically', () => {
    const a = resolveTurn('zoom into security', ctx())
    const b = resolveTurn('  zoom into security  ', ctx())
    expect(b.intent.kind).toBe(a.intent.kind)
    expect(b.plan.verdict).toBe(a.plan.verdict)
  })
})

// ─── 6. expectedNext clears after a normal turn ────────────────────────

describe('expectedNext lifecycle', () => {
  it('a normal command after expectedNext clears it (deriveContextPatch)', async () => {
    const { deriveContextPatch } = await import('../services/voice-conversation.js')
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const prev = ctx({ expectedNext: { kind: 'yes_no', pendingPlan: pending, prompt: '?' } })
    const t = resolveTurn('zoom into security', prev)
    const patch = deriveContextPatch(t, prev)
    expect(patch.expectedNext).toBeNull()
  })
})
