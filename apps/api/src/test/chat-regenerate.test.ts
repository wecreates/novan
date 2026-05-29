/**
 * Tests for the chat regenerate path — refusal cases. The happy path
 * is exercised end-to-end by the streaming route and requires real DB
 * state; here we cover the deterministic refusal branches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Msg = { id: string; role: string; content: string; conversationId: string; supersededAt: number | null; workspaceId: string; createdAt: number }

// Mutable per-test state. The mock's select() pulls from these.
const state: { target: Msg | null; conv: Msg[]; callIndex: number } = { target: null, conv: [], callIndex: 0 }

vi.mock('../db/client.js', () => {
  // select() returns a thenable. First call resolves to [target?] (used
  // with .limit(1).then(r => r[0])), second resolves to state.conv
  // (used with .orderBy(...)). The function only ever makes two reads.
  function selectChain() {
    const useTarget = state.callIndex === 0
    state.callIndex++
    const data = useTarget ? (state.target ? [state.target] : []) : state.conv
    return {
      from:    () => selectChainInner(data),
    }
  }
  function selectChainInner(data: unknown[]) {
    const c: Record<string, unknown> = {}
    c['where']   = () => c
    c['orderBy'] = () => ({
      limit:    () => Promise.resolve(data),
      then:     (cb: (v: unknown) => unknown) => Promise.resolve(data).then(cb),
      catch:    () => Promise.resolve(data),
    })
    c['limit']   = () => Promise.resolve(data)
    c['then']    = (cb: (v: unknown) => unknown) => Promise.resolve(data).then(cb)
    c['catch']   = () => Promise.resolve(data)
    return c
  }
  return {
    db: {
      select: () => selectChain(),
      insert: () => ({ values: () => ({ catch: () => null }) }),
      update: () => ({ set: () => ({ where: () => ({ catch: () => null }) }) }),
      delete: () => ({ where: () => ({ catch: () => null }) }),
    },
  }
})

import { regenerateMessage } from '../services/novan-chat.js'

function setup(target: Msg | null, conv: Msg[] = []) {
  state.target = target
  state.conv = conv
  state.callIndex = 0
}
const msg = (over: Partial<Msg>): Msg => ({
  id: 'm', role: 'assistant', content: '', conversationId: 'c1',
  supersededAt: null, workspaceId: 'ws', createdAt: 1, ...over,
})

beforeEach(() => setup(null, []))

describe('regenerateMessage: refusals', () => {
  it('returns not-found for an unknown message id', async () => {
    setup(null, [])
    const r = await regenerateMessage('ws', 'nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not found/)
  })

  it('refuses to regenerate a user message', async () => {
    setup(msg({ id: 'u1', role: 'user' }), [msg({ id: 'u1', role: 'user' })])
    const r = await regenerateMessage('ws', 'u1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/assistant/)
  })

  it('refuses a target that is already superseded', async () => {
    setup(msg({ id: 'a1', role: 'assistant', supersededAt: 9999 }), [])
    const r = await regenerateMessage('ws', 'a1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/superseded/)
  })

  it('refuses an orphan assistant with no preceding user', async () => {
    const a = msg({ id: 'a1', role: 'assistant' })
    setup(a, [a])
    const r = await regenerateMessage('ws', 'a1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/preceding user/)
  })

  it('returns the user message + regenerateFrom on a clean assistant target', async () => {
    const u = msg({ id: 'u1', role: 'user', content: 'q', createdAt: 1 })
    const a = msg({ id: 'a1', role: 'assistant', content: 'ans', createdAt: 2 })
    setup(a, [u, a])
    const r = await regenerateMessage('ws', 'a1')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.userMessage).toBe('q')
      expect(r.regenerateFrom).toBe('a1')
      expect(r.conversationId).toBe('c1')
    }
  })
})
