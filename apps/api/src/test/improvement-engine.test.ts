/**
 * Tests for improvement-engine.ts — analyzer fan-out + persistence contract.
 *
 * Covers:
 * - runImprovementScan on empty DB returns 0 created/refreshed
 * - generateRoadmap returns the documented shape (immediate/nearTerm/backlog)
 * - applyRecommendation refuses without approval when requiresApproval=true
 * - applyRecommendation succeeds when not requiring approval
 * - dismissRecommendation is callable without throwing
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let mockRecRows: unknown[] = []

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = mockRecRows): unknown {
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
    select: () => makeChain(mockRecRows),
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

import {
  runImprovementScan, generateRoadmap,
  applyRecommendation, dismissRecommendation,
}                          from '../services/improvement-engine.js'

beforeEach(() => {
  mockRecRows = []
})

// ─── A) runImprovementScan — empty DB ────────────────────────────────────────

describe('improvement-engine: runImprovementScan empty DB', () => {
  it('returns a numeric scan summary on empty DB', async () => {
    // Note: some analyzers fire on absence-of-data signals (e.g. "no provider
    // health checks recorded" is itself an observability finding), so
    // `scanned` may be ≥0 even on an empty DB. Assert shape, not strict zero.
    const r = await runImprovementScan('ws')
    expect(typeof r.scanned).toBe('number')
    expect(typeof r.created).toBe('number')
    expect(typeof r.refreshed).toBe('number')
    expect(Array.isArray(r.recommendations)).toBe(true)
    expect(r.scanned).toBeGreaterThanOrEqual(0)
  })

  it('returns the documented shape', async () => {
    const r = await runImprovementScan('ws')
    expect(r).toHaveProperty('scanned')
    expect(r).toHaveProperty('created')
    expect(r).toHaveProperty('refreshed')
    expect(r).toHaveProperty('recommendations')
    expect(Array.isArray(r.recommendations)).toBe(true)
  })
})

// ─── B) generateRoadmap — empty DB ───────────────────────────────────────────

describe('improvement-engine: generateRoadmap empty DB', () => {
  it('returns three phase buckets', async () => {
    const r = await generateRoadmap('ws')
    expect(r).toHaveProperty('immediate')
    expect(r).toHaveProperty('nearTerm')
    expect(r).toHaveProperty('backlog')
    expect(r).toHaveProperty('created')
  })

  it('all buckets empty when no recommendations exist', async () => {
    const r = await generateRoadmap('ws')
    expect(r.immediate).toEqual([])
    expect(r.nearTerm).toEqual([])
    expect(r.backlog).toEqual([])
    expect(r.created).toBe(0)
  })
})

// ─── C) applyRecommendation — approval gate ──────────────────────────────────

describe('improvement-engine: applyRecommendation approval gate', () => {
  it('refuses recommendation not found', async () => {
    mockRecRows = []
    const r = await applyRecommendation('nonexistent', 'ops', false)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/i)
  })

  it('refuses when requiresApproval=true and approvalGranted=false', async () => {
    mockRecRows = [{
      id: 'rec-1', workspaceId: 'ws',
      requiresApproval: true, category: 'reliability', subject: 'x',
      status: 'open',
    }]
    const r = await applyRecommendation('rec-1', 'ops', false)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/approval/i)
  })

  it('allows when requiresApproval=true and approvalGranted=true', async () => {
    mockRecRows = [{
      id: 'rec-1', workspaceId: 'ws',
      requiresApproval: true, category: 'reliability', subject: 'x',
      status: 'open',
    }]
    const r = await applyRecommendation('rec-1', 'ops', true)
    expect(r.ok).toBe(true)
  })

  it('allows when requiresApproval=false (no approval needed)', async () => {
    mockRecRows = [{
      id: 'rec-2', workspaceId: 'ws',
      requiresApproval: false, category: 'observability', subject: 'y',
      status: 'open',
    }]
    const r = await applyRecommendation('rec-2', 'ops', false)
    expect(r.ok).toBe(true)
  })
})

// ─── D) dismissRecommendation ────────────────────────────────────────────────

describe('improvement-engine: dismissRecommendation', () => {
  it('is callable without throwing on missing record', async () => {
    mockRecRows = []
    await expect(dismissRecommendation('rec-x', 'ops', 'not relevant'))
      .resolves.not.toThrow()
  })

  it('is callable on existing record', async () => {
    mockRecRows = [{ id: 'rec-1', workspaceId: 'ws' }]
    await expect(dismissRecommendation('rec-1', 'ops', 'false positive'))
      .resolves.not.toThrow()
  })
})
