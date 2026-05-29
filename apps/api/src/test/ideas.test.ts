/**
 * Tests for ideas.ts — the personal-intelligence-to-product pipeline.
 *
 * Two layers:
 *   A) Pure extraction (no DB) — extractIdeaDrafts() on real-shaped text
 *   B) Persistence + promotion lifecycle (mocked DB + constructBusiness)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock DB before importing the module under test ───────────────────────────
let selectRows: unknown[] = []
let lastReturning: unknown[] = []
const insertCalls: unknown[] = []
const updateCalls: Array<{ set: unknown }> = []

vi.mock('../db/client.js', () => {
  function makeSelectChain(rows: unknown[]): unknown {
    const p: Promise<unknown[]> & Record<string, unknown> = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>
    return new Proxy(p, {
      get(target, prop, receiver) {
        if (prop === 'then' || prop === 'catch' || prop === 'finally') {
          return Reflect.get(target, prop, receiver).bind(target)
        }
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
        return () => makeSelectChain(rows)
      },
    })
  }
  const db = {
    select: () => makeSelectChain(selectRows),
    insert: () => {
      const chain = {
        values: (v: unknown) => { insertCalls.push(v); return chain },
        returning: () => makeSelectChain(lastReturning),
        onConflictDoNothing: () => chain,
        then: (r: (v: unknown[]) => unknown) => r([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      const chain = {
        set: (v: unknown) => { updateCalls.push({ set: v }); return chain },
        where: () => chain,
        returning: () => makeSelectChain(lastReturning),
      }
      return chain
    },
  }
  return { db }
})
vi.mock('../db/schema.js', () => ({ ideas: {}, events: {} }))

const { constructBusinessMock } = vi.hoisted(() => ({
  constructBusinessMock: vi.fn(async (i: { workspaceId: string; brief: string; name?: string }) => ({
    ok: true as const, businessId: 'biz-mock-1', name: i.name ?? 'auto', industry: 'saas',
    brief: i.brief, systems: [], events: 0,
  })),
}))
vi.mock('../services/business-construction.js', () => ({
  constructBusiness: constructBusinessMock,
}))

import {
  extractIdeaDrafts, createOrDedupeIdea, promoteIdea,
} from '../services/ideas.js'

beforeEach(() => {
  selectRows = []
  lastReturning = []
  insertCalls.length = 0
  updateCalls.length = 0
  constructBusinessMock.mockClear()
})

// ── A. Extraction ─────────────────────────────────────────────────────

describe('extractIdeaDrafts', () => {
  it('returns empty for short input', () => {
    expect(extractIdeaDrafts('')).toEqual([])
    expect(extractIdeaDrafts('hi')).toEqual([])
  })

  it('catches "build a X that ..." pattern', () => {
    const text = 'I want to build a Chrome extension that summarizes Hacker News threads in real time.'
    const drafts = extractIdeaDrafts(text)
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts[0]!.title.toLowerCase()).toContain('chrome')
    expect(drafts[0]!.category).toBe('extension')
  })

  it('catches "idea: ..." prefix and tool category', () => {
    const text = 'Idea: AI tool for writers that rewrites paragraphs in different tones.'
    const drafts = extractIdeaDrafts(text)
    expect(drafts.length).toBeGreaterThan(0)
    const cats = drafts.map(d => d.category)
    expect(cats).toContain('ai-tool')
  })

  it('extracts features from bullet list near match', () => {
    const text = `Build a SaaS tool for indie devs that helps ship faster.

- One-click deploy
- Built-in auth
- Per-customer feature flags
- Stripe billing
`
    const drafts = extractIdeaDrafts(text)
    expect(drafts.length).toBeGreaterThan(0)
    const features = drafts[0]!.features ?? []
    expect(features.length).toBeGreaterThanOrEqual(3)
    expect(features.some(f => /deploy/i.test(f))).toBe(true)
  })

  it('dedupes the same title across patterns within one call', () => {
    const text = 'Build a SaaS for teams. Idea: Build a SaaS for teams.'
    const drafts = extractIdeaDrafts(text)
    const titles = new Set(drafts.map(d => d.title.toLowerCase()))
    expect(titles.size).toBe(drafts.length)
  })
})

// ── B. Persistence + promotion ────────────────────────────────────────

describe('createOrDedupeIdea', () => {
  it('creates a new idea when no fingerprint match', async () => {
    selectRows = []                              // no existing
    lastReturning = [{ id: 'idea-1', title: 'X', status: 'raw', category: 'saas' }]
    const r = await createOrDedupeIdea({
      workspaceId: 'ws-1', title: 'X', raw: 'X', category: 'saas', sourceType: 'manual',
    })
    expect(r.created).toBe(true)
    expect(r.idea.id).toBe('idea-1')
  })

  it('returns existing idea when fingerprint matches an open one', async () => {
    selectRows = [{ id: 'idea-old', title: 'X', status: 'clarified', category: 'saas' }]
    const r = await createOrDedupeIdea({
      workspaceId: 'ws-1', title: 'X', raw: 'X', category: 'saas', sourceType: 'manual',
    })
    expect(r.created).toBe(false)
    expect(r.idea.id).toBe('idea-old')
  })
})

describe('promoteIdea', () => {
  it('refuses promotion unless status is blueprinted', async () => {
    selectRows = [{ id: 'idea-1', title: 'X', status: 'raw', workspaceId: 'ws-1', features: [] }]
    await expect(promoteIdea('ws-1', 'idea-1')).rejects.toThrow(/not 'blueprinted'/)
  })

  it('promotes a blueprinted idea, calls constructBusiness, links back', async () => {
    selectRows = [{
      id: 'idea-1', title: 'Demo App', status: 'blueprinted', workspaceId: 'ws-1',
      solution: 'Solve X', painPoint: 'Y is annoying', targetUser: 'devs',
      monetization: '$10/mo', features: ['a','b'],
    }]
    lastReturning = [{ id: 'idea-1', status: 'promoted', promotedToBusinessId: 'biz-mock-1' }]
    const r = await promoteIdea('ws-1', 'idea-1')
    expect(r).not.toBeNull()
    expect(constructBusinessMock).toHaveBeenCalledOnce()
    const call = constructBusinessMock.mock.calls[0]![0]
    expect(call.workspaceId).toBe('ws-1')
    expect(call.name).toBe('Demo App')
    expect(call.brief).toContain('Solve X')
    expect(call.brief).toContain('devs')
    expect(r!.idea.status).toBe('promoted')
  })

  it('allows force-promote from non-blueprinted status', async () => {
    selectRows = [{ id: 'idea-1', title: 'X', status: 'raw', workspaceId: 'ws-1', features: [] }]
    lastReturning = [{ id: 'idea-1', status: 'promoted' }]
    const r = await promoteIdea('ws-1', 'idea-1', { force: true })
    expect(r!.idea.status).toBe('promoted')
    expect(constructBusinessMock).toHaveBeenCalledOnce()
  })

  it('refuses to promote archived or rejected ideas even with force', async () => {
    selectRows = [{ id: 'idea-1', title: 'X', status: 'archived', workspaceId: 'ws-1', features: [] }]
    await expect(promoteIdea('ws-1', 'idea-1', { force: true })).rejects.toThrow(/terminal status/)
  })
})
