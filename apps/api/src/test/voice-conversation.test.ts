/**
 * Tests for voice-conversation — meta commands, carryover, follow-ups,
 * interruption / correction handling, risky ambiguity, low-confidence
 * fallback, context carryover, and natural response style.
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

import {
  resolveTurn, applyCarryover, detectMeta, naturalize, deriveContextPatch, saferAlternative,
  type ConversationContext,
} from '../services/voice-conversation.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'

function ctx(over: Partial<ConversationContext> = {}): ConversationContext {
  return {
    sessionId: 's1', workspaceId: 'ws1',
    currentNode: null, currentTemplate: null, currentLod: null,
    activeMission: null, selectedSystem: null,
    lastPlan: null, pendingPlan: null,
    currentRisk: 'low', currentUiMode: null,
    preferences: {}, turnCount: 0,
    ...over,
  }
}

describe('voice-conversation: meta detection', () => {
  it('detects never_mind', () => {
    expect(detectMeta('never mind')).toBe('never_mind')
    expect(detectMeta('cancel that')).toBe('never_mind')
    expect(detectMeta('forget it')).toBe('never_mind')
  })
  it('detects explain', () => {
    expect(detectMeta('explain that')).toBe('explain')
    expect(detectMeta('what does that mean')).toBe('explain')
  })
  it('detects safer', () => {
    expect(detectMeta('do the safer option')).toBe('safer')
    expect(detectMeta('less risky')).toBe('safer')
  })
  it('detects correction', () => {
    expect(detectMeta('actually, do something else')).toBe('correction')
    expect(detectMeta('no, do X instead')).toBe('correction')
  })
  it('returns null for normal text', () => {
    expect(detectMeta('zoom into security')).toBeNull()
  })
})

describe('voice-conversation: follow-up + carryover', () => {
  it('resolves "zoom in" using selectedSystem', () => {
    const r = applyCarryover('zoom in', ctx({ selectedSystem: 'security' }))
    expect(r.text).toMatch(/security/i)
    expect(r.carryover?.resolvedTo).toBe('security')
  })
  it('resolves "focus on it" using selectedSystem', () => {
    const r = applyCarryover('focus on it', ctx({ selectedSystem: 'agents' }))
    expect(r.text.toLowerCase()).toContain('agents')
  })
  it('does not modify text when system already present', () => {
    const r = applyCarryover('zoom into research', ctx({ selectedSystem: 'security' }))
    expect(r.text).toBe('zoom into research')
    expect(r.carryover).toBeUndefined()
  })
  it('does not modify when no context available', () => {
    const r = applyCarryover('zoom in', ctx())
    expect(r.text).toBe('zoom in')
  })
  it('full turn: follow-up command picks up carryover', () => {
    const t = resolveTurn('open its detail', ctx({ selectedSystem: 'runtime' }))
    expect(t.intent.kind).toMatch(/^brain\./)
    expect(t.carryover?.resolvedTo).toBe('runtime')
  })
})

describe('voice-conversation: interruption + never_mind', () => {
  it('never_mind cancels pending plan', () => {
    const pending = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const t = resolveTurn('never mind', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('never_mind')
    expect(t.plan.verdict).toBe('execute')
    expect(t.plan.speak.toLowerCase()).toContain('cancel')
  })
  it('never_mind with no pending plan still acknowledges', () => {
    const t = resolveTurn('cancel that', ctx())
    expect(t.meta).toBe('never_mind')
    expect(t.plan.verdict).toBe('execute')
  })
  it('deriveContextPatch clears pendingPlan after never_mind', () => {
    const pending = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const prev = ctx({ pendingPlan: pending })
    const t = resolveTurn('never mind', prev)
    const patch = deriveContextPatch(t, prev)
    expect(patch.pendingPlan).toBeNull()
  })
})

describe('voice-conversation: correction', () => {
  it('correction with new intent replaces pending plan', () => {
    const pending = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const t = resolveTurn('actually, zoom into security', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('correction')
    expect(t.intent.kind).toBe('brain.zoom')
    expect(t.intent.target).toBe('security')
  })
  it('correction without parsable intent asks for clarification', () => {
    const pending = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const t = resolveTurn('actually, hmmmm', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('clarify')
    expect(t.clarification).toBeTruthy()
  })
})

describe('voice-conversation: explain + repeat + safer + confirm', () => {
  it('explain reads the last plan reason', () => {
    const last = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    const t = resolveTurn('explain that', ctx({ lastPlan: last }))
    expect(t.meta).toBe('explain')
    expect(t.plan.speak.toLowerCase()).toContain('security')
  })
  it('explain with no last plan still answers gracefully', () => {
    const t = resolveTurn('explain that', ctx())
    expect(t.meta).toBe('explain')
    expect(t.plan.speak).toBeTruthy()
  })
  it('repeat returns the last plan speak', () => {
    const last = routeIntent(parseIntent('summarize today'), 'summarize today')
    const t = resolveTurn('say that again', ctx({ lastPlan: last }))
    expect(t.meta).toBe('repeat')
    expect(t.naturalSpeak).toBeTruthy()
  })
  it('safer derives a lower-risk alternative for pause-all', () => {
    const pending = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const t = resolveTurn('do the safer option', ctx({ pendingPlan: pending, selectedSystem: 'security' }))
    expect(t.meta).toBe('safer')
    expect(t.plan.risk).toBe('medium')
    expect(t.plan.intent.args['scope']).not.toBe('all')
  })
  it('safer on already-safe action says so', () => {
    const safe = routeIntent(parseIntent('summarize today'), 'summarize today')
    const t = resolveTurn('safer option', ctx({ lastPlan: safe }))
    expect(t.meta).toBe('safer')
    expect(t.plan.speak.toLowerCase()).toMatch(/already/)
  })
  it('confirm executes pending plan when present', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const t = resolveTurn('confirm', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('confirm')
    expect(t.plan.intent.kind).toBe(pending.intent.kind)
  })
  it('confirm without pending says nothing pending', () => {
    const t = resolveTurn('go ahead', ctx())
    expect(t.meta).toBe('confirm')
    expect(t.plan.speak.toLowerCase()).toContain('nothing pending')
  })
})

describe('voice-conversation: risky ambiguity + low-confidence fallback', () => {
  it('unknown utterance with no context asks to rephrase', () => {
    const t = resolveTurn('flarg blax', ctx())
    expect(t.meta).toBe('clarify')
    expect(t.plan.verdict).toBe('execute')
    expect(t.clarification).toBeTruthy()
  })
  it('unknown utterance with selectedSystem suggests options scoped to it', () => {
    const t = resolveTurn('xyzzy', ctx({ selectedSystem: 'security' }))
    expect(t.meta).toBe('clarify')
    expect(t.clarification?.toLowerCase()).toContain('security')
  })
  it('unknown utterance with pending plan suggests confirm/cancel', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const t = resolveTurn('mmm', ctx({ pendingPlan: pending }))
    expect(t.meta).toBe('clarify')
    expect(t.clarification?.toLowerCase()).toMatch(/confirm|never mind/)
  })
})

describe('voice-conversation: natural response style', () => {
  it('strips hype words', () => {
    expect(naturalize('Absolutely, I will definitely focus on security.')).not.toMatch(/absolutely/i)
    expect(naturalize('Absolutely, I will definitely focus on security.')).not.toMatch(/definitely/i)
  })
  it('caps very long responses', () => {
    const long = Array.from({ length: 40 }, () => 'word').join(' ') + '.'
    const out = naturalize(long)
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(23)
  })
  it('returns original-ish when already concise', () => {
    expect(naturalize('Focusing on security.')).toMatch(/security/i)
  })
  it('never returns empty for non-empty input', () => {
    expect(naturalize('Just do it.')).toBeTruthy()
  })
})

describe('voice-conversation: context carryover via deriveContextPatch', () => {
  it('zoom updates selectedSystem and lod=focus', () => {
    const t = resolveTurn('zoom into security', ctx())
    const patch = deriveContextPatch(t, ctx())
    expect(patch.selectedSystem).toBe('security')
    expect(patch.currentLod).toBe('focus')
    expect(patch.currentNode).toBe('security')
  })
  it('global view clears selectedSystem', () => {
    const t = resolveTurn('return to global view', ctx({ selectedSystem: 'agents' }))
    const patch = deriveContextPatch(t, ctx({ selectedSystem: 'agents' }))
    expect(patch.selectedSystem).toBeNull()
    expect(patch.currentLod).toBe('global')
  })
  it('template switch updates currentTemplate', () => {
    const t = resolveTurn('switch template to galaxy', ctx())
    const patch = deriveContextPatch(t, ctx())
    expect(patch.currentTemplate).toBe('galaxy')
  })
  it('confirm plan persists pendingPlan as null after confirm', () => {
    const pending = routeIntent(parseIntent('pause research'), 'pause research')
    const prev = ctx({ pendingPlan: pending })
    const t = resolveTurn('confirm', prev)
    const patch = deriveContextPatch(t, prev)
    expect(patch.pendingPlan).toBeNull()
  })
  it('confirm-able mutating plan is stored as pendingPlan', () => {
    const t = resolveTurn('pause all agents', ctx())
    const patch = deriveContextPatch(t, ctx())
    expect(patch.pendingPlan).toBeTruthy()
    expect(patch.pendingPlan?.verdict).toBe('confirm')
  })
  it('turn count increments each turn', () => {
    const prev = ctx({ turnCount: 3 })
    const t = resolveTurn('zoom into runtime', prev)
    expect(deriveContextPatch(t, prev).turnCount).toBe(4)
  })
})

describe('voice-conversation: saferAlternative', () => {
  it('downgrades pause-all to a single-system pause', () => {
    const plan = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    const safer = saferAlternative(plan)
    expect(safer).not.toBeNull()
    expect(safer!.risk).toBe('medium')
    expect(safer!.intent.args['scope']).not.toBe('all')
  })
  it('converts research start to dry-run', () => {
    const plan = routeIntent(parseIntent('start research on x'), 'start research on x')
    const safer = saferAlternative(plan)
    expect(safer).not.toBeNull()
    expect(safer!.execute?.body?.['dryRun']).toBe(true)
  })
  it('converts browser open to screenshot', () => {
    const plan = routeIntent(parseIntent('navigate to example.com'), 'navigate to example.com')
    const safer = saferAlternative(plan)
    expect(safer!.execute?.path).toMatch(/screenshot/)
  })
  it('returns null for already-low-risk plans', () => {
    const plan = routeIntent(parseIntent('summarize today'), 'summarize today')
    expect(saferAlternative(plan)).toBeNull()
  })
})

describe('voice-conversation: safety invariants', () => {
  it('hard-blocked utterance still rejects even with carryover context', () => {
    const t = resolveTurn('buy me a laptop for $1500', ctx({ selectedSystem: 'commerce' }))
    expect(t.plan.verdict).toBe('reject')
  })
  it('correction cannot resurrect a hard-blocked action', () => {
    const t = resolveTurn('actually, purchase that for $500', ctx({ pendingPlan: routeIntent(parseIntent('zoom into security'), 'zoom into security') }))
    expect(t.plan.verdict).toBe('reject')
  })
})
