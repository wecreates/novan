/**
 * Tests for production-readiness.ts — the 14-check launch auditor + launch lock.
 *
 * Focus on logic that doesn't require complex DB mocking:
 *  - applyOverride confirmation-style guard (reason length)
 *  - runAudit aggregates check results into a score and persists
 *  - score formula penalises critical blockers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── DB mock with per-table query routing ─────────────────────────────────────
// runAudit fans out across many tables. We return empty rows for all queries
// (= "unverified" for evidence checks). Override-tests don't need DB writes
// to succeed since the contract is reason-length first.
let writeCallCount = 0

vi.mock('../db/client.js', () => {
  function makeChain(returnValue: unknown[] = []): unknown {
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
    select: () => makeChain([]),
    insert: () => {
      writeCallCount += 1
      const chain = {
        values: () => chain,
        onConflictDoNothing: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve([]),
        catch: () => chain,
      }
      return chain
    },
    update: () => {
      writeCallCount += 1
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

import { applyOverride, runAudit } from '../services/production-readiness.js'

beforeEach(() => {
  writeCallCount = 0
})

// ─── A) applyOverride — reason length is the documented guard ────────────────

describe('production-readiness: applyOverride reason gate', () => {
  it('refuses empty reason', async () => {
    const r = await applyOverride('ws', 'admin', '')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/reason/i)
  })

  it('refuses reason shorter than 5 chars (per service contract)', async () => {
    const r = await applyOverride('ws', 'admin', 'no')
    expect(r.ok).toBe(false)
  })

  it('refuses whitespace-only reasons', async () => {
    const r = await applyOverride('ws', 'admin', '     ')
    expect(r.ok).toBe(false)
  })

  it('refuses when no launch lock exists yet (no audit run)', async () => {
    // DB mock returns [] for every select → service should refuse with "run audit first"
    const r = await applyOverride('ws', 'admin', 'This is a real reason for override')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/audit/i)
  })
})

// ─── B) runAudit returns a structured report even with no evidence ───────────

describe('production-readiness: runAudit with empty DB', () => {
  it('returns an AuditReport with all expected fields', async () => {
    const r = await runAudit('ws')
    expect(r).toHaveProperty('auditId')
    expect(r).toHaveProperty('readinessScore')
    expect(r).toHaveProperty('passedCount')
    expect(r).toHaveProperty('failedCount')
    expect(r).toHaveProperty('unverifiedCount')
    expect(r).toHaveProperty('skippedCount')
    expect(r).toHaveProperty('criticalBlockers')
    expect(Array.isArray(r.results)).toBe(true)
    expect(Array.isArray(r.recommendedFixes)).toBe(true)
  })

  it('returns ≥14 checks (full launch checklist incl. security-team)', async () => {
    const r = await runAudit('ws')
    expect(r.results.length).toBeGreaterThanOrEqual(14)
  })

  it('score formula: empty DB → critical blockers exist → score < 100', async () => {
    const r = await runAudit('ws')
    expect(r.readinessScore).toBeLessThan(100)
    expect(r.readinessScore).toBeGreaterThanOrEqual(0)
  })

  it('every result has a name, status, severity, reason', async () => {
    const r = await runAudit('ws')
    for (const c of r.results) {
      expect(c).toHaveProperty('name')
      expect(c).toHaveProperty('status')
      expect(c).toHaveProperty('severity')
      expect(c).toHaveProperty('reason')
      expect(['passed', 'failed', 'unverified', 'skipped']).toContain(c.status)
      expect(['critical', 'high', 'medium', 'low']).toContain(c.severity)
    }
  })

  it('recommendedFixes is a string array, one entry per failed/unverified-critical', async () => {
    const r = await runAudit('ws')
    expect(r.recommendedFixes.length).toBe(r.failedCount + r.results.filter(
      (c) => c.status === 'unverified' && c.severity === 'critical',
    ).length)
    for (const fix of r.recommendedFixes) expect(typeof fix).toBe('string')
  })

  it('persists the audit (writes ≥1 row across launch_audits + launch_locks)', async () => {
    await runAudit('ws')
    // First-time: inserts both audit row + lock row. Subsequent: updates lock.
    expect(writeCallCount).toBeGreaterThan(0)
  })

  it('returns the same number of checks regardless of workspace', async () => {
    const a = await runAudit('ws-a')
    const b = await runAudit('ws-b')
    expect(a.results.length).toBe(b.results.length)
  })
})

// ─── C) Score boundaries on an empty DB are reasonable ───────────────────────

describe('production-readiness: score behaviour', () => {
  it('score is bounded in [0, 100]', async () => {
    const r = await runAudit('ws')
    expect(r.readinessScore).toBeGreaterThanOrEqual(0)
    expect(r.readinessScore).toBeLessThanOrEqual(100)
  })

  it('passedCount + failedCount + unverifiedCount + skippedCount = total checks', async () => {
    const r = await runAudit('ws')
    expect(r.passedCount + r.failedCount + r.unverifiedCount + r.skippedCount)
      .toBe(r.results.length)
  })
})
