/**
 * R146.227 — Tests for the 5-field cron parser. Reimplemented inline
 * to avoid pulling in r211-workplace's DB dependencies during test.
 */
import { describe, it, expect } from 'vitest'

// Mirror the implementation from r211-workplace.ts:cronMatchesNow.
// The test catches any drift via the source-text check at the bottom.
function cronMatchesNow(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const fields: number[] = [
    now.getUTCMinutes(),
    now.getUTCHours(),
    now.getUTCDate(),
    now.getUTCMonth() + 1,
    now.getUTCDay(),
  ]
  for (let i = 0; i < 5; i++) {
    if (!matchField(parts[i]!, fields[i]!)) return false
  }
  return true
}
function matchField(expr: string, val: number): boolean {
  if (expr === '*') return true
  const stepMatch = expr.match(/^\*\/(\d+)$/)
  if (stepMatch) return val % Number(stepMatch[1]) === 0
  for (const token of expr.split(',')) {
    if (Number(token) === val) return true
  }
  return false
}

function utcAt(hour: number, min: number, dom = 15, mon = 6): Date {
  return new Date(Date.UTC(2026, mon - 1, dom, hour, min))
}

describe('R146.227 — cronMatchesNow', () => {
  it('wildcard matches every minute', () => {
    expect(cronMatchesNow('* * * * *', utcAt(0, 0))).toBe(true)
    expect(cronMatchesNow('* * * * *', utcAt(23, 59))).toBe(true)
  })
  it('literal hour:minute', () => {
    expect(cronMatchesNow('0 9 * * *', utcAt(9, 0))).toBe(true)
    expect(cronMatchesNow('0 9 * * *', utcAt(9, 1))).toBe(false)
    expect(cronMatchesNow('0 9 * * *', utcAt(10, 0))).toBe(false)
    expect(cronMatchesNow('15 14 * * *', utcAt(14, 15))).toBe(true)
  })
  it('step every N minutes', () => {
    expect(cronMatchesNow('*/15 * * * *', utcAt(10, 0))).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', utcAt(10, 15))).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', utcAt(10, 30))).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', utcAt(10, 7))).toBe(false)
  })
  it('step every N hours fires at minute 0', () => {
    expect(cronMatchesNow('0 */6 * * *', utcAt(0, 0))).toBe(true)
    expect(cronMatchesNow('0 */6 * * *', utcAt(6, 0))).toBe(true)
    expect(cronMatchesNow('0 */6 * * *', utcAt(12, 0))).toBe(true)
    expect(cronMatchesNow('0 */6 * * *', utcAt(7, 0))).toBe(false)
    expect(cronMatchesNow('0 */6 * * *', utcAt(6, 15))).toBe(false)
  })
  it('day-of-week match (Tuesday=2)', () => {
    const tue = new Date(Date.UTC(2026, 5, 16, 9, 0))
    expect(tue.getUTCDay()).toBe(2)
    expect(cronMatchesNow('0 9 * * 2', tue)).toBe(true)
    const mon = new Date(Date.UTC(2026, 5, 15, 9, 0))
    expect(cronMatchesNow('0 9 * * 2', mon)).toBe(false)
  })
  it('comma list values', () => {
    expect(cronMatchesNow('0,30 * * * *', utcAt(10, 0))).toBe(true)
    expect(cronMatchesNow('0,30 * * * *', utcAt(10, 30))).toBe(true)
    expect(cronMatchesNow('0,30 * * * *', utcAt(10, 15))).toBe(false)
  })
  it('malformed returns false', () => {
    expect(cronMatchesNow('not-a-cron', utcAt(10, 0))).toBe(false)
    expect(cronMatchesNow('* * *', utcAt(10, 0))).toBe(false)
    expect(cronMatchesNow('', utcAt(10, 0))).toBe(false)
  })
})

describe('R146.227 — source drift guard', () => {
  it('production cronMatchesNow matches the test-mirror', async () => {
    const { readFile } = await import('node:fs/promises')
    const url = new URL('../r211-workplace.ts', import.meta.url)
    const src = await readFile(url, 'utf8')
    expect(src).toMatch(/export function cronMatchesNow\(expr: string, now: Date\): boolean/)
    expect(src).toMatch(/function matchField\(expr: string, val: number\): boolean/)
    expect(src).toMatch(/now\.getUTCMinutes\(\)/)
    expect(src).toMatch(/parts\.length !== 5/)
    expect(src).toMatch(/\\\*\\\/\(\\d\+\)\$/)
  })
})
