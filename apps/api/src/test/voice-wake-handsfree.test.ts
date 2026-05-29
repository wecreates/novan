/**
 * Tests for the wake-phrase / hands-free / interruption / ambient layer.
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

import { detectWake, gateTranscript, normalizePhrases } from '../services/voice-wake.js'
import { classifyForHandsFree } from '../services/voice-handsfree-policy.js'
import { resolveTurn, deriveContextPatch, type ConversationContext } from '../services/voice-conversation.js'
import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'
import { scanForBriefings, aboveFloor, classifyEvent } from '../services/voice-ambient.js'

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

// ─── Wake-phrase detection ──────────────────────────────────────────────

describe('voice-wake: detectWake', () => {
  const phrases = ['hey novan', 'novan']

  it('strips "hey novan, …" from a command', () => {
    const r = detectWake('Hey Novan, zoom into security', phrases)
    expect(r.matched).toBe(true)
    expect(r.phrase).toBe('hey novan')
    expect(r.remainder).toBe('zoom into security')
  })

  it('matches bare "Novan, …" too', () => {
    const r = detectWake('Novan, what needs attention?', phrases)
    expect(r.matched).toBe(true)
    expect(r.remainder.toLowerCase()).toContain('what needs attention')
  })

  it('accepts "ok novan" / "yo novan" leading filler', () => {
    expect(detectWake('ok novan, summarize today', phrases).matched).toBe(true)
    expect(detectWake('yo novan summarize today',  phrases).matched).toBe(true)
  })

  it('does not match unrelated phrases', () => {
    expect(detectWake('the runtime looks fine',     phrases).matched).toBe(false)
    expect(detectWake('Novannah pushed a commit',   phrases).matched).toBe(false)  // word boundary
  })

  it('prefers the longest matching phrase ("hey novan" beats "novan")', () => {
    const r = detectWake('hey novan zoom into runtime', phrases)
    expect(r.phrase).toBe('hey novan')
  })

  it('strips trailing politeness fillers from the remainder', () => {
    const r = detectWake('hey novan, please zoom into security', phrases)
    expect(r.remainder).toBe('zoom into security')
  })

  it('returns no match on empty input', () => {
    expect(detectWake('', phrases).matched).toBe(false)
  })

  it('normalizePhrases dedupes + sorts by length descending', () => {
    expect(normalizePhrases(['  Hey Novan  ', 'novan', 'NOVAN', 'hey novan']))
      .toEqual(['hey novan', 'novan'])
  })
})

describe('voice-wake: gateTranscript', () => {
  it('passes through when wake is not required', () => {
    const r = gateTranscript('zoom into security', { wakeRequired: false })
    expect(r.ok).toBe(true)
    expect(r.remainder).toBe('zoom into security')
  })

  it('drops the utterance when wake required but not present', () => {
    const r = gateTranscript('zoom into security', { wakeRequired: true, phrases: ['hey novan'] })
    expect(r.ok).toBe(false)
    expect(r.remainder).toBe('')
  })

  it('returns the remainder when wake present', () => {
    const r = gateTranscript('hey novan zoom into security', { wakeRequired: true, phrases: ['hey novan'] })
    expect(r.ok).toBe(true)
    expect(r.remainder).toBe('zoom into security')
  })

  it('bare wake phrase ("hey novan") is acknowledged with empty remainder', () => {
    const r = gateTranscript('hey novan', { wakeRequired: true, phrases: ['hey novan'] })
    expect(r.ok).toBe(true)
    expect(r.remainder).toBe('')
  })
})

// ─── Hands-free policy ──────────────────────────────────────────────────

describe('voice-handsfree-policy: classification', () => {
  it('safe brain navigation auto-allowed in hands-free', () => {
    const plan = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    const d = classifyForHandsFree({ enabled: true, plan })
    expect(d.verdict).toBe('allow')
  })

  it('mutating research.pause requires approval even in hands-free', () => {
    const plan = routeIntent(parseIntent('pause research'), 'pause research')
    const d = classifyForHandsFree({ enabled: true, plan })
    expect(d.verdict).toBe('require_approval')
  })

  it('image draft allowed in hands-free', () => {
    const plan = routeIntent(parseIntent('generate an image of a city'), 'generate an image of a city')
    const d = classifyForHandsFree({ enabled: true, plan })
    expect(d.verdict).toBe('allow')
    expect(d.category).toBe('draft')
  })

  it('research.start (medium risk) allowed as draft', () => {
    const plan = routeIntent(parseIntent('start research on x'), 'start research on x')
    const d = classifyForHandsFree({ enabled: true, plan })
    expect(d.verdict).toBe('allow')
    expect(d.category).toBe('draft')
  })

  it('hard-blocked plans stay blocked regardless of hands-free', () => {
    const plan = routeIntent(parseIntent('buy a laptop'), 'buy me a laptop for $1500')
    const d = classifyForHandsFree({ enabled: true, plan })
    expect(d.verdict).toBe('block')
  })

  it('hands-free disabled: navigation still allowed, mutations still require approval', () => {
    const nav = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    expect(classifyForHandsFree({ enabled: false, plan: nav }).verdict).toBe('allow')
    const mut = routeIntent(parseIntent('pause research'), 'pause research')
    expect(classifyForHandsFree({ enabled: false, plan: mut }).verdict).toBe('require_approval')
  })

  it('operator allow-list overrides the default', () => {
    const plan = routeIntent(parseIntent('pause research'), 'pause research')
    const d = classifyForHandsFree({ enabled: true, allowedIntents: ['research.pause'], plan })
    expect(d.verdict).toBe('allow')
  })

  it('operator allow-list cannot override hard-blocks', () => {
    const plan = routeIntent(parseIntent('buy a laptop'), 'buy me a laptop for $1500')
    const d = classifyForHandsFree({ enabled: true, allowedIntents: ['unknown'], plan })
    expect(d.verdict).toBe('block')
  })
})

// ─── Interruption meta: stop / mute / lock / unlock ─────────────────────

describe('voice-conversation: interruption metas', () => {
  it('"stop" produces a stop turn that clears pending without canceling lastPlan', () => {
    const t = resolveTurn('stop', ctx({ lastPlan: routeIntent(parseIntent('zoom into security'), 'zoom into security') }))
    expect(t.meta).toBe('stop')
    expect(t.plan.speak.toLowerCase()).toContain('stop')
  })

  it('"pause" / "hold on" map to stop', () => {
    expect(resolveTurn('pause', ctx()).meta).toBe('stop')
    expect(resolveTurn('hold on', ctx()).meta).toBe('stop')
  })

  it('"mute for 10" sets mutedUntil ~10 minutes ahead', () => {
    const t = resolveTurn('mute for 10', ctx())
    expect(t.meta).toBe('mute')
    const patch = deriveContextPatch(t, ctx())
    expect(typeof patch.mutedUntil).toBe('number')
    expect(Number(patch.mutedUntil) - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(Number(patch.mutedUntil) - Date.now()).toBeLessThan(11 * 60_000)
  })

  it('"mute" without minutes defaults to 5 min and returns empty speak', () => {
    const t = resolveTurn('mute', ctx())
    expect(t.meta).toBe('mute')
    expect(t.naturalSpeak).toBe('')                 // intentionally silent
  })

  it('"lock voice actions" sets voiceLocked true', () => {
    const t = resolveTurn('lock voice actions', ctx())
    expect(t.meta).toBe('lock')
    const patch = deriveContextPatch(t, ctx())
    expect(patch.voiceLocked).toBe(true)
  })

  it('once locked, mutating plans are rejected with a lock notice', () => {
    const t = resolveTurn('pause research', ctx({ voiceLocked: true }))
    expect(t.plan.verdict).toBe('reject')
    expect(t.plan.speak.toLowerCase()).toContain('lock')
  })

  it('navigation plans are still allowed while voice is locked (read-only)', () => {
    const t = resolveTurn('zoom into security', ctx({ voiceLocked: true }))
    expect(t.plan.verdict).toBe('navigate')
  })

  it('"unlock voice" clears the lock', () => {
    const t = resolveTurn('unlock voice', ctx({ voiceLocked: true }))
    expect(t.meta).toBe('unlock')
    const patch = deriveContextPatch(t, ctx({ voiceLocked: true }))
    expect(patch.voiceLocked).toBe(false)
  })

  it('hard-blocks override lock messaging (purchase still rejects with safety reason)', () => {
    const t = resolveTurn('buy a laptop for $500', ctx({ voiceLocked: true }))
    expect(t.plan.verdict).toBe('reject')
    expect(t.plan.speak).toMatch(/refus|hard-blocked/i)
  })
})

// ─── Ambient briefing classification ────────────────────────────────────

describe('voice-ambient: classifyEvent', () => {
  it('routes runtime errors to incident', () => {
    const r = classifyEvent({ id: '1', type: 'runtime.error', payload: { severity: 'critical', summary: 'API crashed' } })
    expect(r?.kind).toBe('incident')
    expect(r?.severity).toBe('critical')
  })

  it('routes budget breaches to budget', () => {
    const r = classifyEvent({ id: '1', type: 'budget.exceeded', payload: { severity: 'high', message: 'monthly cap reached' } })
    expect(r?.kind).toBe('budget')
  })

  it('routes pending approvals', () => {
    const r = classifyEvent({ id: '1', type: 'approval.pending', payload: { severity: 'high' } })
    expect(r?.kind).toBe('approval')
  })

  it('routes agent failures', () => {
    const r = classifyEvent({ id: '1', type: 'agent.crashed', payload: { agent: 'commerce-worker' } })
    expect(r?.kind).toBe('agent_failure')
  })

  it('routes security alerts and forces critical severity', () => {
    const r = classifyEvent({ id: '1', type: 'security.suspicious', payload: { message: 'burst of failed logins' } })
    expect(r?.kind).toBe('security')
    expect(r?.severity).toBe('critical')
  })

  it('ignores unrelated event types', () => {
    expect(classifyEvent({ id: '1', type: 'user.login', payload: {} })).toBeNull()
  })
})

describe('voice-ambient: scanForBriefings', () => {
  it('filters by severity floor', () => {
    const rows = [
      { id: '1', type: 'runtime.error',       payload: { severity: 'normal',   summary: 'minor' } },
      { id: '2', type: 'budget.exceeded',     payload: { severity: 'critical', summary: 'cap' } },
      { id: '3', type: 'approval.pending',    payload: { severity: 'high',     summary: 'needs sign-off' } },
    ]
    const critOnly = scanForBriefings(rows, { floor: 'critical' })
    expect(critOnly.length).toBe(1)
    expect(critOnly[0]?.kind).toBe('budget')
    const highPlus = scanForBriefings(rows, { floor: 'high' })
    expect(highPlus.length).toBe(2)
  })

  it('skips already-delivered source events', () => {
    const rows = [{ id: 'ev1', type: 'runtime.error', payload: { severity: 'critical' } }]
    const seen = new Set(['ev1'])
    expect(scanForBriefings(rows, { floor: 'critical', alreadyDelivered: seen }).length).toBe(0)
  })

  it('aboveFloor severity ordering is correct', () => {
    expect(aboveFloor('critical', 'high')).toBe(true)
    expect(aboveFloor('high',     'critical')).toBe(false)
    expect(aboveFloor('normal',   'normal')).toBe(true)
  })
})

// ─── Safety invariants under wake/handsfree ────────────────────────────

describe('voice-wake-handsfree: safety invariants', () => {
  it('hard-blocked transcripts reject even after wake', () => {
    const wake = gateTranscript('hey novan, buy a laptop for $1500', { wakeRequired: true, phrases: ['hey novan'] })
    expect(wake.ok).toBe(true)
    const t = resolveTurn(wake.remainder, ctx())
    expect(t.plan.verdict).toBe('reject')
  })

  it('hands-free + lock combined: lock wins, plan rejects', () => {
    const plan = routeIntent(parseIntent('pause research'), 'pause research')
    expect(classifyForHandsFree({ enabled: true, plan }).verdict).toBe('require_approval')
    // But if the session is voice-locked the resolver rejects before
    // reaching hands-free policy:
    const t = resolveTurn('pause research', ctx({ voiceLocked: true }))
    expect(t.plan.verdict).toBe('reject')
  })
})
