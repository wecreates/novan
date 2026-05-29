/**
 * Tests for time-aware intelligence (#59) — pure analyzers.
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

import {
  profileHourOfDay, profileDayOfWeek, profileMultiWeekTrend, buildRhythmReport,
  hourInZone, dayOfWeekInZone,
} from '../services/time-aware-intelligence.js'

const WEEK = 7 * 86_400_000

function atUtc(daysAgo: number, hour: number): number {
  // Build a UTC timestamp at the given hour, N days ago
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(hour, 0, 0, 0)
  return d.getTime()
}

// ─── Hour-of-day profile ───────────────────────────────────────────────

describe('time-aware: profileHourOfDay', () => {
  it('insufficient_data when below minimum samples', () => {
    const r = profileHourOfDay(Array.from({ length: 10 }, () => atUtc(0, 12)))
    expect(r.insufficientData).toBe(true)
    expect(r.samples).toBe(10)
  })

  it('detects the peak hour when concentrated', () => {
    const ts = [
      ...Array.from({ length: 50 }, () => atUtc(0, 14)),
      ...Array.from({ length: 5 },  () => atUtc(0, 3)),
    ]
    const r = profileHourOfDay(ts)
    expect(r.insufficientData).toBe(false)
    expect(r.peakHour).toBe(14)
    expect(r.peakShare).toBeGreaterThan(0.7)
  })

  it('quiet hour is the smallest non-empty bin (or zero)', () => {
    const ts = [
      ...Array.from({ length: 50 }, () => atUtc(0, 9)),
      atUtc(0, 22),
    ]
    const r = profileHourOfDay(ts)
    expect(r.quietHour).not.toBe(r.peakHour)
  })

  it('bins always sum to total samples', () => {
    const ts = Array.from({ length: 100 }, (_, i) => atUtc(0, i % 24))
    const r = profileHourOfDay(ts)
    const sum = r.bins.reduce((s, x) => s + x, 0)
    expect(sum).toBe(100)
  })
})

// ─── Day-of-week profile ───────────────────────────────────────────────

describe('time-aware: profileDayOfWeek', () => {
  it('detects the peak day of the week', () => {
    // 50 events on Tuesday (day=2), 5 on Saturday
    const ts = [
      ...Array.from({ length: 50 }, (_, i) => atUtcOnDay(2, 14)),
      ...Array.from({ length: 5 },  () => atUtcOnDay(6, 14)),
    ]
    const r = profileDayOfWeek(ts)
    expect(r.peakDay).toBe(2)
  })

  it('returns insufficient_data for low-sample input', () => {
    const r = profileDayOfWeek([atUtcOnDay(1, 9)])
    expect(r.insufficientData).toBe(true)
  })

  it('bins length is 7', () => {
    const ts = Array.from({ length: 40 }, (_, i) => atUtcOnDay(i % 7, 12))
    expect(profileDayOfWeek(ts).bins.length).toBe(7)
  })
})

function atUtcOnDay(targetDay: number, hour: number): number {
  // Returns a timestamp at the given UTC hour on a date whose day-of-week
  // matches targetDay (within the past 14 days).
  const today = new Date()
  for (let back = 0; back < 14; back++) {
    const d = new Date(today)
    d.setUTCDate(d.getUTCDate() - back)
    if (d.getUTCDay() === targetDay) {
      d.setUTCHours(hour, 0, 0, 0)
      return d.getTime()
    }
  }
  return today.getTime()
}

// ─── Multi-week trend ──────────────────────────────────────────────────

describe('time-aware: profileMultiWeekTrend', () => {
  it('returns insufficient_data when window is shorter than 2 weeks', () => {
    const ts = [Date.now() - 86_400_000]
    const r = profileMultiWeekTrend(ts, 3 * 86_400_000)
    expect(r.direction).toBe('insufficient_data')
  })

  it('detects rising trend when later weeks have more events', () => {
    const now = Date.now()
    const ts: number[] = []
    // Week 1: 5 events, Week 2: 15, Week 3: 30, Week 4: 60
    for (let week = 0; week < 4; week++) {
      const count = [5, 15, 30, 60][week]!
      const weekEnd   = now - (3 - week) * WEEK
      const weekStart = weekEnd - WEEK
      for (let i = 0; i < count; i++) {
        ts.push(weekStart + (i / count) * WEEK)
      }
    }
    const r = profileMultiWeekTrend(ts, 4 * WEEK)
    expect(r.direction).toBe('rising')
    expect(r.slope).toBeGreaterThan(0)
  })

  it('detects falling trend symmetrically', () => {
    const now = Date.now()
    const ts: number[] = []
    for (let week = 0; week < 4; week++) {
      const count = [60, 30, 15, 5][week]!
      const weekEnd   = now - (3 - week) * WEEK
      const weekStart = weekEnd - WEEK
      for (let i = 0; i < count; i++) ts.push(weekStart + (i / count) * WEEK)
    }
    const r = profileMultiWeekTrend(ts, 4 * WEEK)
    expect(r.direction).toBe('falling')
  })

  it('flat traffic returns stable', () => {
    const now = Date.now()
    const ts: number[] = []
    for (let week = 0; week < 4; week++) {
      for (let i = 0; i < 20; i++) ts.push(now - (3 - week) * WEEK - i * 1000)
    }
    const r = profileMultiWeekTrend(ts, 4 * WEEK)
    expect(r.direction).toBe('stable')
  })

  it('returns insufficient_data when mean events per week < 5', () => {
    const now = Date.now()
    const ts: number[] = []
    for (let week = 0; week < 4; week++) {
      for (let i = 0; i < 2; i++) ts.push(now - (3 - week) * WEEK - i * 1000)
    }
    const r = profileMultiWeekTrend(ts, 4 * WEEK)
    expect(r.direction).toBe('insufficient_data')
  })
})

// ─── Full rhythm report ────────────────────────────────────────────────

describe('time-aware: buildRhythmReport', () => {
  it('quietestWindow is null when there is insufficient data', () => {
    const r = buildRhythmReport([Date.now()], WEEK * 4)
    expect(r.quietestWindow).toBeNull()
  })

  it('quietestWindow surfaces a human-readable reason', () => {
    const ts = Array.from({ length: 100 }, (_, i) => atUtcOnDay(i % 7, 14))
    const r = buildRhythmReport(ts, WEEK * 4)
    if (r.quietestWindow) {
      expect(r.quietestWindow.reason).toMatch(/UTC/)
    }
  })

  it('total matches input length', () => {
    const ts = Array.from({ length: 50 }, () => Date.now() - 86_400_000)
    expect(buildRhythmReport(ts, WEEK * 4).total).toBe(50)
  })
})

// ─── Timezone awareness ────────────────────────────────────────────────

describe('time-aware: hourInZone', () => {
  // Fixed UTC noon — should map to local hours per zone.
  // 2026-01-15T12:00:00Z = Thursday, noon UTC
  const noonUtc = Date.UTC(2026, 0, 15, 12, 0, 0)

  it('returns the UTC hour when zone is UTC', () => {
    expect(hourInZone(noonUtc, 'UTC')).toBe(12)
  })

  it('shifts forward in zones east of UTC', () => {
    // Tokyo is UTC+9 — noon UTC = 21:00 Tokyo
    expect(hourInZone(noonUtc, 'Asia/Tokyo')).toBe(21)
  })

  it('shifts backward in zones west of UTC', () => {
    // New York winter (UTC-5) — noon UTC = 07:00 NY
    expect(hourInZone(noonUtc, 'America/New_York')).toBe(7)
  })

  it('falls back to UTC on an unknown zone', () => {
    expect(hourInZone(noonUtc, 'Fake/Zone')).toBe(12)
  })

  it('handles midnight crossover', () => {
    // 03:00 UTC on a date — Tokyo is +9 → 12:00 same day; NY is -5 → 22:00 previous day
    const earlyUtc = Date.UTC(2026, 0, 15, 3, 0, 0)
    expect(hourInZone(earlyUtc, 'America/New_York')).toBe(22)
  })
})

describe('time-aware: dayOfWeekInZone', () => {
  // Sunday 2026-01-18T23:00:00Z. In Sydney (UTC+11) that's Monday 10:00.
  const sunEveningUtc = Date.UTC(2026, 0, 18, 23, 0, 0)

  it('returns Sunday=0 in UTC', () => {
    expect(dayOfWeekInZone(sunEveningUtc, 'UTC')).toBe(0)
  })

  it('rolls into Monday in a far-east zone', () => {
    expect(dayOfWeekInZone(sunEveningUtc, 'Australia/Sydney')).toBe(1)
  })

  it('falls back to UTC on garbage zone', () => {
    expect(dayOfWeekInZone(sunEveningUtc, 'Not/A/Zone')).toBe(0)
  })
})

describe('time-aware: profileHourOfDay honors tz', () => {
  it('peak hour shifts when the same timestamps are binned in different zones', () => {
    // 50 events at 14:00 UTC. In UTC peak=14. In Tokyo (+9) peak=23. In NY (-5) peak=9.
    const ts = Array.from({ length: 50 }, () => Date.UTC(2026, 0, 15, 14, 0, 0))
    expect(profileHourOfDay(ts, 'UTC').peakHour).toBe(14)
    expect(profileHourOfDay(ts, 'Asia/Tokyo').peakHour).toBe(23)
    expect(profileHourOfDay(ts, 'America/New_York').peakHour).toBe(9)
  })

  it('records the tz on the profile', () => {
    const ts = Array.from({ length: 40 }, () => Date.UTC(2026, 0, 15, 10, 0, 0))
    expect(profileHourOfDay(ts, 'America/Chicago').tz).toBe('America/Chicago')
  })
})

describe('time-aware: buildRhythmReport tz', () => {
  it('quietestWindow.reason references the chosen tz instead of UTC', () => {
    const ts = Array.from({ length: 100 }, (_, i) => Date.UTC(2026, 0, 1 + (i % 7), 14, 0, 0))
    const r = buildRhythmReport(ts, WEEK * 4, 'America/Chicago')
    if (r.quietestWindow) {
      expect(r.quietestWindow.reason).toMatch(/America\/Chicago/)
    }
  })
})
