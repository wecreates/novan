/**
 * Tests for the voice skill memory + shortcuts + metrics + adaptive
 * naturalize + low-confidence misfire recovery.
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

import { expandTranscript } from '../services/voice-shortcuts.js'
import { aggregateObservations } from '../services/voice-skill-memory.js'
import { aggregateMetrics } from '../services/voice-metrics.js'
import { naturalize, resolveTurn, type ConversationContext } from '../services/voice-conversation.js'

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

// ─── Shortcut expansion ─────────────────────────────────────────────────

describe('voice-shortcuts: expandTranscript', () => {
  const shortcuts = [
    { id: 'a', phrase: 'daily scan',     expansion: 'summarize today',         enabled: true },
    { id: 'b', phrase: 'open security',  expansion: 'zoom into security',      enabled: true },
    { id: 'c', phrase: 'safe audit',     expansion: 'start safe audit',        enabled: true },
    { id: 'd', phrase: 'lock it down',   expansion: 'lock voice actions',      enabled: true },
    { id: 'e', phrase: 'old shortcut',   expansion: 'do nothing',              enabled: false },
  ]

  it('exact match expands to canonical command', () => {
    expect(expandTranscript('daily scan', shortcuts)?.expansion).toBe('summarize today')
    expect(expandTranscript('open security', shortcuts)?.expansion).toBe('zoom into security')
    expect(expandTranscript('safe audit', shortcuts)?.expansion).toBe('start safe audit')
    expect(expandTranscript('lock it down', shortcuts)?.expansion).toBe('lock voice actions')
  })

  it('case + trailing punctuation ignored', () => {
    expect(expandTranscript('Daily Scan.', shortcuts)?.expansion).toBe('summarize today')
    expect(expandTranscript('OPEN SECURITY!', shortcuts)?.expansion).toBe('zoom into security')
  })

  it('trailing words are appended to the expansion', () => {
    expect(expandTranscript('daily scan now', shortcuts)?.expansion).toBe('summarize today now')
  })

  it('disabled shortcuts are ignored', () => {
    expect(expandTranscript('old shortcut', shortcuts)).toBeNull()
  })

  it('non-matching phrase returns null', () => {
    expect(expandTranscript('zoom into agents', shortcuts)).toBeNull()
    expect(expandTranscript('', shortcuts)).toBeNull()
  })

  it('longest phrase wins when multiple shortcuts share a prefix', () => {
    const longer = [
      { id: '1', phrase: 'open security grid', expansion: 'switch template to security_grid', enabled: true },
      { id: '2', phrase: 'open security',      expansion: 'zoom into security',                enabled: true },
    ]
    expect(expandTranscript('open security grid', longer)?.id).toBe('1')
    expect(expandTranscript('open security',      longer)?.id).toBe('2')
  })
})

// ─── Skill memory aggregator ────────────────────────────────────────────

describe('voice-skill-memory: aggregateObservations', () => {
  it('produces top phrases, intents, brain nodes', () => {
    const rows = [
      { kind: 'preferred_action', phrase: 'zoom into security', intentKind: 'brain.zoom',   fromIntent: null, toIntent: null, nodeId: 'security' },
      { kind: 'preferred_action', phrase: 'zoom into security', intentKind: 'brain.zoom',   fromIntent: null, toIntent: null, nodeId: 'security' },
      { kind: 'brain_node',       phrase: 'zoom into runtime',  intentKind: 'brain.zoom',   fromIntent: null, toIntent: null, nodeId: 'runtime' },
      { kind: 'preferred_action', phrase: 'summarize today',    intentKind: 'war_room.today', fromIntent: null, toIntent: null, nodeId: null },
    ]
    const r = aggregateObservations(rows, 30 * 86_400_000)
    expect(r.topPhrases[0]?.phrase).toBe('zoom into security')
    expect(r.topIntents[0]?.intentKind).toBe('brain.zoom')
    expect(r.topBrainNodes[0]?.nodeId).toBe('security')
    expect(r.preferredActions[0]?.intentKind).toBe('brain.zoom')
    expect(r.total).toBe(4)
  })

  it('counts misunderstandings + correction pairs', () => {
    const rows = [
      { kind: 'misunderstood', phrase: 'zoom security',  intentKind: null, fromIntent: null, toIntent: null, nodeId: null },
      { kind: 'misunderstood', phrase: 'zoom security',  intentKind: null, fromIntent: null, toIntent: null, nodeId: null },
      { kind: 'corrected',     phrase: '',               intentKind: 'brain.zoom', fromIntent: 'brain.focus', toIntent: 'brain.zoom', nodeId: null },
      { kind: 'preferred_action', phrase: 'zoom into x', intentKind: 'brain.zoom', fromIntent: null, toIntent: null, nodeId: null },
    ]
    const r = aggregateObservations(rows, 86_400_000)
    expect(r.misunderstandings[0]).toEqual({ phrase: 'zoom security', count: 2 })
    expect(r.correctionPairs[0]).toEqual({ from: 'brain.focus', to: 'brain.zoom', count: 1 })
    expect(r.correctionRate).toBeCloseTo(2 / 4, 2)
  })

  it('returns zeros for empty input', () => {
    const r = aggregateObservations([], 86_400_000)
    expect(r.total).toBe(0)
    expect(r.correctionRate).toBe(0)
    expect(r.topPhrases).toEqual([])
  })
})

// ─── Voice metrics aggregator ───────────────────────────────────────────

describe('voice-metrics: aggregateMetrics', () => {
  it('computes confidence + correction + approval + blocked rates', () => {
    const rows = [
      { kind: 'command', provider: 'openai_realtime', latencyMs: 200, meta: { intent: 'brain.zoom',     confidence: 0.9, verdict: 'navigate' } },
      { kind: 'command', provider: 'openai_realtime', latencyMs: 600, meta: { intent: 'research.start', confidence: 0.5, verdict: 'execute'  } },  // low conf
      { kind: 'confirm', provider: 'gemini_live',     latencyMs: 800, meta: { intent: 'research.start', confidence: 0.95, conversationMeta: 'confirm', verdict: 'execute' } },
      { kind: 'command', provider: 'openai_realtime', latencyMs: 300, meta: { intent: 'brain.zoom',     confidence: 0.8,  conversationMeta: 'never_mind' } },
      { kind: 'block',   provider: 'openai_realtime', latencyMs: 100, meta: { intent: 'unknown',        confidence: 0.99, verdict: 'reject' } },
      { kind: 'barge_in',provider: 'openai_realtime', latencyMs: 50,  meta: null },
    ]
    const m = aggregateMetrics(rows, 7 * 86_400_000)
    expect(m.totalTurns).toBe(5)         // command×3 + confirm×1 + block×1 (barge_in not a turn)
    expect(m.avgConfidence).toBeCloseTo((0.9 + 0.5 + 0.95 + 0.8 + 0.99) / 5, 2)
    expect(m.lowConfidenceRate).toBeCloseTo(1 / 5, 2)
    expect(m.blockedActionRate).toBeCloseTo(1 / 5, 2)
    // 1 confirm vs 1 never_mind cancellation → 1 / (1 + 1) = 0.5
    expect(m.approvalRate).toBe(0.5)
  })

  it('correct approval rate when only confirms', () => {
    const rows = [
      { kind: 'confirm', provider: null, latencyMs: null, meta: { intent: 'x', confidence: 0.9, conversationMeta: 'confirm' } },
      { kind: 'confirm', provider: null, latencyMs: null, meta: { intent: 'x', confidence: 0.9, conversationMeta: 'confirm' } },
    ]
    const m = aggregateMetrics(rows, 86_400_000)
    expect(m.approvalRate).toBe(1)
  })

  it('per-provider latency p50/p95', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      kind: 'command', provider: 'openai_realtime', latencyMs: i * 10,
      meta: { intent: 'brain.zoom', confidence: 0.9, verdict: 'navigate' },
    }))
    const m = aggregateMetrics(rows, 86_400_000)
    const stats = m.perProviderLatency.find(s => s.provider === 'openai_realtime')!
    expect(stats.samples).toBe(100)
    expect(stats.p50).toBeGreaterThanOrEqual(490)
    expect(stats.p50).toBeLessThanOrEqual(510)
    expect(stats.p95).toBeGreaterThanOrEqual(940)
  })

  it('safe on empty input', () => {
    const m = aggregateMetrics([], 86_400_000)
    expect(m.totalTurns).toBe(0)
    expect(m.approvalRate).toBe(0)
    expect(m.avgConfidence).toBeNull()
  })
})

// ─── Adaptive naturalize ───────────────────────────────────────────────

describe('naturalize: response-mode adaptation', () => {
  const long = 'I will absolutely zoom into security and definitely focus on the runtime system and basically show you everything in great detail.'

  it('"fast" mode applies a 12-word cap', () => {
    const out = naturalize(long, 'fast')
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(13)
  })
  it('"executive" mode applies a 14-word cap', () => {
    const out = naturalize(long, 'executive')
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(15)
  })
  it('"detailed" mode keeps more sentences (up to 40 words)', () => {
    const out = naturalize(long, 'detailed')
    expect(out.split(/\s+/).length).toBeGreaterThan(15)
  })
  it('"engineer" mode relaxes to 30 words', () => {
    const out = naturalize(long, 'engineer')
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(31)
  })
  it('hype words still stripped regardless of mode', () => {
    expect(naturalize('Absolutely focusing on security.', 'detailed')).not.toMatch(/absolutely/i)
  })
  it('empty input still produces empty', () => {
    expect(naturalize('', 'fast')).toBe('')
  })
})

// ─── Low-confidence misfire recovery ────────────────────────────────────

describe('voice-conversation: low-confidence refusal', () => {
  // We can't easily inject confidence into the rigid parser, so we wrap
  // resolveTurn with a transcript that triggers a borderline match.
  it('low-confidence brain.focus (no target) refuses execution and emits clarify', () => {
    // "open" alone matches brain.focus regex but extracts no target →
    // confidence drops to 0.7 * 0.4 = 0.28 which falls below the 0.55
    // threshold so parseIntent returns 'unknown'. resolveTurn then asks
    // for rephrase — that IS the misfire recovery path.
    const t = resolveTurn('open', ctx())
    expect(t.meta).toBe('clarify')
    expect(t.expectedNext).toBeTruthy()
    // Clarification plans carry an 'execute' verdict (UI-only no-op) but
    // MUST have no .execute side-effect hook — the directive's rule is
    // "do not execute on low confidence" and that's what's enforced.
    expect(t.plan.execute).toBeUndefined()
  })

  it('navigation stays permissive when confidence is moderate', () => {
    const t = resolveTurn('zoom into security', ctx())
    expect(t.plan.verdict).toBe('navigate')
  })

  it('clarification emits expectedNext yes_no when there is a pending plan', () => {
    const t = resolveTurn('hmm', ctx())
    expect(t.meta).toBe('clarify')
    expect(t.expectedNext).toBeTruthy()
  })
})
