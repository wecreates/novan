/**
 * Tests for business-portfolio.ts — the parts that are testable without
 * a live Postgres: earningsMonth() and setMonthlyTarget()'s floor refusal.
 *
 * Full integration of statusFor / weeklyReview / recordRevenue requires
 * a real DB and is covered separately.
 */
import { describe, it, expect, vi } from 'vitest'

// DB chain mock — every method returns the same chainable proxy that
// resolves to []. Matches the pattern used in agency-catalog.test.ts.
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

import { earningsMonth, setMonthlyTarget } from '../services/business-portfolio.js'

// ─── earningsMonth ────────────────────────────────────────────────────────

describe('earningsMonth', () => {
  it('formats current time as YYYY-MM (UTC)', () => {
    const m = earningsMonth()
    expect(m).toMatch(/^\d{4}-\d{2}$/)
  })

  it('uses the UTC month, not the local one', () => {
    // 2026-05-15 18:00 UTC — May regardless of operator timezone
    const m = earningsMonth(Date.UTC(2026, 4, 15, 18, 0, 0))   // month index 4 = May
    expect(m).toBe('2026-05')
  })

  it('pads single-digit months with a leading zero', () => {
    // January
    const m = earningsMonth(Date.UTC(2026, 0, 5))
    expect(m).toBe('2026-01')
  })

  it('handles year boundaries correctly', () => {
    expect(earningsMonth(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12')
    expect(earningsMonth(Date.UTC(2027,  0,  1,  0,  0,  0))).toBe('2027-01')
  })

  it('returns a string of length 7', () => {
    expect(earningsMonth(Date.now()).length).toBe(7)
  })
})

// ─── setMonthlyTarget: $10k floor refusal ─────────────────────────────────

describe('setMonthlyTarget: $10k floor enforcement', () => {
  it('refuses targets below $10,000', async () => {
    const r = await setMonthlyTarget('ws-1', 'biz-1', 5_000)
    expect(r.ok).toBe(false)
    expect(r.effectiveTarget).toBe(10_000)
    expect(r.reason).toMatch(/10,?000/)
  })

  it('refuses exactly $9,999', async () => {
    const r = await setMonthlyTarget('ws-1', 'biz-1', 9_999)
    expect(r.ok).toBe(false)
  })

  it('refuses non-finite values (NaN, Infinity, negative)', async () => {
    expect((await setMonthlyTarget('ws-1', 'biz-1', NaN)).ok).toBe(false)
    expect((await setMonthlyTarget('ws-1', 'biz-1', Infinity)).ok).toBe(false)
    expect((await setMonthlyTarget('ws-1', 'biz-1', -100)).ok).toBe(false)
  })

  it('rejects when business is not found (DB mock returns empty)', async () => {
    // Mocked select returns [] → business not found path.
    const r = await setMonthlyTarget('ws-1', 'nonexistent', 15_000)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/i)
  })

  it('returns the $10k default effectiveTarget on refusal', async () => {
    const r = await setMonthlyTarget('ws-1', 'biz-1', 500)
    expect(r.effectiveTarget).toBe(10_000)
  })
})
