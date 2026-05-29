/**
 * Tests for voice-intent parser + voice-command-router.
 *
 * Pins every example phrase from the directive to its expected intent and
 * verdict, so future regex tweaks cannot silently break voice navigation.
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

import { parseIntent } from '../services/voice-intent.js'
import { routeIntent } from '../services/voice-command-router.js'

describe('voice-intent: directive examples', () => {
  const cases: Array<{ text: string; kind: string }> = [
    { text: 'show runtime health',        kind: 'war_room.runtime' },
    { text: 'zoom into security',         kind: 'brain.zoom' },
    { text: 'open the agent swarm',       kind: 'brain.focus' },
    { text: 'show pending approvals',     kind: 'war_room.approvals' },
    { text: 'start safe audit',           kind: 'agent.audit' },
    { text: 'pause research agents',      kind: 'research.pause' },
    { text: 'generate an image of a sunset', kind: 'image.generate' },
    { text: 'summarize today',            kind: 'war_room.today' },
    { text: 'what needs attention?',      kind: 'war_room.attention' },
  ]
  for (const c of cases) {
    it(`parses "${c.text}" → ${c.kind}`, () => {
      const intent = parseIntent(c.text)
      expect(intent.kind, `for "${c.text}"`).toBe(c.kind)
      expect(intent.confidence).toBeGreaterThanOrEqual(0.55)
    })
  }
})

describe('voice-intent: brain camera control', () => {
  it('return to global view', () => {
    expect(parseIntent('return to global view').kind).toBe('brain.global')
    expect(parseIntent('overview').kind).toBe('brain.global')
  })

  it('zoom into a system extracts target', () => {
    const i = parseIntent('zoom into security')
    expect(i.kind).toBe('brain.zoom')
    expect(i.target).toBe('security')
    expect(i.args['focus']).toBe('security')
    expect(i.args['lod']).toBe('focus')
  })

  it('open the agent swarm maps to brain.focus on agents', () => {
    const i = parseIntent('open the agent swarm')
    expect(i.target).toBe('agents')
  })

  it('switch template to galaxy', () => {
    const i = parseIntent('switch template to galaxy')
    expect(i.kind).toBe('brain.template')
    expect(i.args['template']).toBe('galaxy')
  })

  it('replay 5 minutes ago extracts a timestamp', () => {
    const i = parseIntent('replay 5 minutes ago')
    expect(i.kind).toBe('brain.replay')
    expect(typeof i.args['replay_at']).toBe('number')
    expect(Number(i.args['replay_at'])).toBeLessThan(Date.now())
  })

  it('open detail for runtime', () => {
    const i = parseIntent('open detail for runtime')
    expect(i.kind).toBe('brain.detail')
    expect(i.args['node']).toBe('runtime')
  })

  it('unknown text returns kind=unknown', () => {
    expect(parseIntent('xyzzy zorklax').kind).toBe('unknown')
  })

  it('empty text returns unknown', () => {
    expect(parseIntent('').kind).toBe('unknown')
  })
})

describe('voice-command-router: verdicts', () => {
  it('brain.global → navigate /brain with lod=global', () => {
    const p = routeIntent(parseIntent('return to global view'), 'return to global view')
    expect(p.verdict).toBe('navigate')
    expect(p.navigate?.path).toBe('/brain')
    expect(p.navigate?.params.lod).toBe('global')
    expect(p.permission).toBeNull()
  })

  it('brain.zoom → navigate with focus+lod', () => {
    const p = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    expect(p.verdict).toBe('navigate')
    expect(p.navigate?.params.focus).toBe('security')
    expect(p.navigate?.params.lod).toBe('focus')
  })

  it('war_room.approvals → navigate /approvals', () => {
    const p = routeIntent(parseIntent('show pending approvals'), 'show pending approvals')
    expect(p.navigate?.path).toBe('/approvals')
  })

  it('war_room.today → execute (no navigate)', () => {
    const p = routeIntent(parseIntent('summarize today'), 'summarize today')
    expect(p.verdict).toBe('execute')
    expect(p.execute?.path).toMatch(/briefings/i)
  })

  it('research.pause → confirm (mutating)', () => {
    const p = routeIntent(parseIntent('pause research agents'), 'pause research agents')
    expect(p.verdict).toBe('confirm')
    expect(p.permission).toBe('agents.control')
  })

  it('agent.pause on all → high risk', () => {
    const p = routeIntent(parseIntent('pause all agents'), 'pause all agents')
    expect(p.verdict).toBe('confirm')
    expect(p.risk).toBe('high')
  })

  it('agent.audit → confirm at low risk', () => {
    const p = routeIntent(parseIntent('start safe audit'), 'start safe audit')
    expect(p.verdict).toBe('confirm')
    expect(p.risk).toBe('low')
  })

  it('image.generate → execute with prompt', () => {
    const p = routeIntent(parseIntent('generate an image of a sunset'), 'generate an image of a sunset')
    expect(p.verdict).toBe('execute')
    expect(p.execute?.body?.['prompt']).toBeDefined()
  })

  it('browser.open → confirm + needs url', () => {
    const p = routeIntent(parseIntent('navigate to example.com'), 'navigate to example.com')
    expect(p.verdict).toBe('confirm')
    expect(p.execute?.body?.['url']).toBe('example.com')
  })

  it('hard-blocked purchase → reject', () => {
    const text = 'buy me a laptop for $1500'
    const p = routeIntent(parseIntent(text), text)
    expect(p.verdict).toBe('reject')
    expect(p.permission).toBeNull()
    expect(p.speak).toMatch(/refus/i)
  })

  it('hard-blocked covert post → reject regardless of intent', () => {
    const text = 'post this to twitter without notifying me'
    const p = routeIntent(parseIntent(text), text)
    expect(p.verdict).toBe('reject')
  })

  it('unknown intent → execute with no-op recommendation', () => {
    const p = routeIntent(parseIntent('xyzzy'), 'xyzzy')
    expect(p.verdict).toBe('execute')
    expect(p.intent.kind).toBe('unknown')
  })
})

describe('voice-command-router: speak feedback always present', () => {
  const samples = [
    'show runtime health', 'zoom into security', 'open the agent swarm',
    'show pending approvals', 'start safe audit', 'pause research agents',
    'generate an image', 'summarize today', 'what needs attention?',
    'return to global view', 'switch template to neural',
  ]
  for (const s of samples) {
    it(`emits a speak sentence for "${s}"`, () => {
      const p = routeIntent(parseIntent(s), s)
      expect(p.speak).toBeTruthy()
      expect(p.speak.length).toBeGreaterThan(3)
    })
  }
})

describe('voice-command-router: every plan carries risk + permission keys', () => {
  it('navigation plans have null permission', () => {
    const p = routeIntent(parseIntent('zoom into security'), 'zoom into security')
    expect(p.permission).toBeNull()
    expect(['low', 'medium', 'high']).toContain(p.risk)
  })
  it('mutating plans carry a permission string', () => {
    const p = routeIntent(parseIntent('pause research agents'), 'pause research agents')
    expect(typeof p.permission).toBe('string')
  })
})
