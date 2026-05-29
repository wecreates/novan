/**
 * Tests for the voice analytics aggregations — composite rollup math
 * and session-summary derivation from voice_events.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Fixture rows used by the mock; each test replaces this array.
const _rows = {
  events: [] as Array<{ kind: string; role: string | null; text: string | null; provider: string | null; meta: Record<string, unknown> | null; createdAt: number; sessionId: string; workspaceId: string }>,
  sessions: [] as Array<{ id: string; workspaceId: string; failoverCount: number; blockedCommands: number; avgLatencyMs: number | null; startedAt: number; endedAt: number | null }>,
}

vi.mock('../db/client.js', () => {
  // Call-order dispatch — summarizeSession runs Promise.all with sessions
  // first (limit 1, .then picks [0]) and events second. Tests reset
  // _selectCallIndex between runs via beforeEach.
  const ctx = { selectCallIndex: 0 }
  ;(globalThis as unknown as { __voiceAnalyticsMockCtx: typeof ctx }).__voiceAnalyticsMockCtx = ctx

  function selector(kind: 'sessions' | 'events') {
    const data = () => kind === 'events' ? _rows.events : _rows.sessions
    const chain: Record<string, unknown> = {}
    chain['from']     = () => chain
    chain['where']    = () => chain
    chain['orderBy']  = () => chain
    chain['limit']    = () => ({
      then:  (cb: (v: unknown) => unknown) => Promise.resolve(data()).then(cb),
      catch: () => Promise.resolve(data()),
    })
    chain['then']     = (cb: (v: unknown) => unknown) => Promise.resolve(data()).then(cb)
    chain['catch']    = () => chain
    return chain
  }
  return {
    db: {
      select: () => {
        const kind: 'sessions' | 'events' = ctx.selectCallIndex === 0 ? 'sessions' : 'events'
        ctx.selectCallIndex++
        return selector(kind)
      },
      insert: () => ({ values: () => ({ catch: () => null, then: (cb: (v: unknown) => unknown) => Promise.resolve().then(cb) }) }),
      update: () => ({ set: () => ({ where: () => ({ catch: () => null }) }) }),
      delete: () => ({ where: () => ({ catch: () => null }) }),
    },
  }
})

import { summarizeSession } from '../services/voice-context-store.js'

describe('voice-analytics: summarizeSession aggregations', () => {
  beforeEach(() => {
    const ctx = (globalThis as unknown as { __voiceAnalyticsMockCtx?: { selectCallIndex: number } }).__voiceAnalyticsMockCtx
    if (ctx) ctx.selectCallIndex = 0
  })

  it('counts accepted / rejected / corrected / clarified across event kinds', async () => {
    _rows.sessions = [{ id: 'sess-1', workspaceId: 'ws', failoverCount: 1, blockedCommands: 2, avgLatencyMs: 420, startedAt: 1000, endedAt: 6000 }]
    _rows.events = [
      { kind: 'command', role: 'user',      text: 'zoom into security',  provider: 'openai_realtime', meta: { intent: 'brain.zoom',     verdict: 'navigate', risk: 'low' }, createdAt: 1100, sessionId: 'sess-1', workspaceId: 'ws' },
      { kind: 'command', role: 'user',      text: 'pause research',      provider: 'openai_realtime', meta: { intent: 'research.pause', verdict: 'confirm',  risk: 'medium' }, createdAt: 1200, sessionId: 'sess-1', workspaceId: 'ws' },
      { kind: 'confirm', role: 'user',      text: 'yes',                 provider: 'openai_realtime', meta: { intent: 'research.pause', conversationMeta: 'confirm', verdict: 'confirm' }, createdAt: 1300, sessionId: 'sess-1', workspaceId: 'ws' },
      { kind: 'block',   role: 'user',      text: 'buy a laptop',        provider: 'openai_realtime', meta: { intent: 'unknown',        verdict: 'reject',   risk: 'high' }, createdAt: 1400, sessionId: 'sess-1', workspaceId: 'ws' },
      { kind: 'command', role: 'user',      text: 'actually never mind', provider: 'openai_realtime', meta: { intent: 'unknown', conversationMeta: 'correction', verdict: 'execute' }, createdAt: 1500, sessionId: 'sess-1', workspaceId: 'ws' },
      { kind: 'clarify', role: 'assistant', text: 'rephrase?',           provider: null,              meta: null, createdAt: 1600, sessionId: 'sess-1', workspaceId: 'ws' },
    ]
    const s = await summarizeSession('sess-1', 'ws')
    expect(s).not.toBeNull()
    if (!s) return
    expect(s.accepted).toBe(4)            // 3 command + 1 confirm
    expect(s.rejected).toBe(1)
    expect(s.corrected).toBe(1)
    expect(s.clarified).toBe(1)
    expect(s.failovers).toBe(1)
    expect(s.blockedCommands).toBe(2)
    expect(s.avgLatencyMs).toBe(420)
    expect(s.durationMs).toBe(5000)
  })

  it('derives top intents in descending order', async () => {
    _rows.sessions = [{ id: 'sess-2', workspaceId: 'ws', failoverCount: 0, blockedCommands: 0, avgLatencyMs: null, startedAt: 0, endedAt: null }]
    _rows.events = [
      { kind: 'command', role: 'user', text: '', provider: null, meta: { intent: 'brain.zoom' }, createdAt: 1, sessionId: 'sess-2', workspaceId: 'ws' },
      { kind: 'command', role: 'user', text: '', provider: null, meta: { intent: 'brain.zoom' }, createdAt: 2, sessionId: 'sess-2', workspaceId: 'ws' },
      { kind: 'command', role: 'user', text: '', provider: null, meta: { intent: 'brain.zoom' }, createdAt: 3, sessionId: 'sess-2', workspaceId: 'ws' },
      { kind: 'command', role: 'user', text: '', provider: null, meta: { intent: 'war_room.today' }, createdAt: 4, sessionId: 'sess-2', workspaceId: 'ws' },
    ]
    const s = await summarizeSession('sess-2', 'ws')
    if (!s) throw new Error('null summary')
    expect(s.topIntents[0]).toEqual({ kind: 'brain.zoom', count: 3 })
    expect(s.topIntents[1]).toEqual({ kind: 'war_room.today', count: 1 })
  })

  it('collects unique providers used', async () => {
    _rows.sessions = [{ id: 'sess-3', workspaceId: 'ws', failoverCount: 0, blockedCommands: 0, avgLatencyMs: null, startedAt: 0, endedAt: null }]
    _rows.events = [
      { kind: 'command', role: 'user', text: '', provider: 'openai_realtime', meta: null, createdAt: 1, sessionId: 'sess-3', workspaceId: 'ws' },
      { kind: 'command', role: 'user', text: '', provider: 'gemini_live',     meta: null, createdAt: 2, sessionId: 'sess-3', workspaceId: 'ws' },
      { kind: 'command', role: 'user', text: '', provider: 'openai_realtime', meta: null, createdAt: 3, sessionId: 'sess-3', workspaceId: 'ws' },
    ]
    const s = await summarizeSession('sess-3', 'ws')
    expect(s?.providersUsed.sort()).toEqual(['gemini_live', 'openai_realtime'])
  })

  it('captures first user line + last assistant line for transcript preview', async () => {
    _rows.sessions = [{ id: 'sess-4', workspaceId: 'ws', failoverCount: 0, blockedCommands: 0, avgLatencyMs: null, startedAt: 0, endedAt: null }]
    _rows.events = [
      { kind: 'command', role: 'user',      text: 'first user line',   provider: null, meta: null, createdAt: 1, sessionId: 'sess-4', workspaceId: 'ws' },
      { kind: 'command', role: 'user',      text: 'second user line',  provider: null, meta: null, createdAt: 2, sessionId: 'sess-4', workspaceId: 'ws' },
      { kind: 'tts',     role: 'assistant', text: 'first asst reply',  provider: null, meta: null, createdAt: 3, sessionId: 'sess-4', workspaceId: 'ws' },
      { kind: 'tts',     role: 'assistant', text: 'second asst reply', provider: null, meta: null, createdAt: 4, sessionId: 'sess-4', workspaceId: 'ws' },
    ]
    const s = await summarizeSession('sess-4', 'ws')
    expect(s?.transcriptHead).toBe('first user line')
    expect(s?.transcriptTail).toBe('second asst reply')
  })

  it('returns null when both session and events are empty', async () => {
    _rows.sessions = []
    _rows.events   = []
    const s = await summarizeSession('nope', 'ws')
    expect(s).toBeNull()
  })
})
