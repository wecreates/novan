/**
 * Tests for conversation-branching — pure validation + branch root derivation.
 * (The DB-bound forkConversation is exercised separately via integration.)
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

import { validateForkRequest, deriveBranchRootId } from '../services/conversation-branching.js'

const conv = { id: 'c1', workspaceId: 'w1', branchRootId: null }
const msg  = { id: 'm1', conversationId: 'c1', supersededAt: null as number | null }

describe('conversation-branching: validateForkRequest', () => {
  it('passes for a live message in the source conversation', () => {
    const r = validateForkRequest({
      sourceConversation: conv, forkPointMessage: msg, sourceConversationId: 'c1',
    })
    expect(r.ok).toBe(true)
  })

  it('rejects when source conversation is missing', () => {
    const r = validateForkRequest({
      sourceConversation: null, forkPointMessage: msg, sourceConversationId: 'c1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/source conversation/i)
  })

  it('rejects when fork-point message is missing', () => {
    const r = validateForkRequest({
      sourceConversation: conv, forkPointMessage: null, sourceConversationId: 'c1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/fork-point/i)
  })

  it('rejects when fork-point belongs to a different conversation', () => {
    const r = validateForkRequest({
      sourceConversation: conv,
      forkPointMessage: { ...msg, conversationId: 'other' },
      sourceConversationId: 'c1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not belong/i)
  })

  it('rejects forking from a superseded message', () => {
    const r = validateForkRequest({
      sourceConversation: conv,
      forkPointMessage: { ...msg, supersededAt: 1234 },
      sourceConversationId: 'c1',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/superseded/i)
  })
})

describe('conversation-branching: deriveBranchRootId', () => {
  it('first-level branch inherits the parent id as root', () => {
    expect(deriveBranchRootId({ id: 'root', branchRootId: null })).toBe('root')
  })

  it('deeper branch inherits the parent\'s branchRootId', () => {
    expect(deriveBranchRootId({ id: 'middle', branchRootId: 'root' })).toBe('root')
  })

  it('returns a string for any valid input', () => {
    expect(typeof deriveBranchRootId({ id: 'x', branchRootId: null })).toBe('string')
    expect(typeof deriveBranchRootId({ id: 'x', branchRootId: 'r' })).toBe('string')
  })
})
