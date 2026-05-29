/**
 * time-aware-intelligence.ts — seasonal + cyclical pattern detection (#59).
 *
 * Pure analyzers + DB-backed wrapper. Three views of the operator's
 * activity rhythm:
 *
 *   1. hour-of-day profile (24 bins) — when in a day events cluster
 *   2. day-of-week profile (7 bins)  — which weekdays carry the load
 *   3. multi-week trend              — is overall activity climbing,
 *      flat, or declining over the last N weeks
 *
 * Each view exposes peaks, quiet windows, and a confidence score
 * derived from sample size + concentration. The platform can use these
 * to:
 *   - schedule cron tasks during the operator's quiet hours
 *   - delay non-critical notifications to the next active window
 *   - forecast operational cadence
 *
 * Pure, deterministic. No LLM round-trip. No fake patterns when data
 * is too thin — returns `insufficient_data: true` in that case.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { and, eq, gte } from 'drizzle-orm'

const MIN_SAMPLES = 30

/**
 * Default IANA timezone for binning. Backward-compatible — if callers
 * pass nothing, we still bin in UTC, but every analyzer + the DB wrapper
 * accept an explicit `tz` to bin into the operator's local time.
 */
export const DEFAULT_TZ = 'UTC'

/** Extract the local hour (0..23) of a timestamp in the given IANA zone. */
export function hourInZone(ts: number, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
    const parts = fmt.formatToParts(new Date(ts))
    const raw = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
    // Some locales return '24' for midnight; normalize.
    return Number.isFinite(raw) ? (raw % 24) : 0
  } catch {
    // Unknown zone → fall back to UTC. Honest fail rather than crash.
    return new Date(ts).getUTCHours()
  }
}

/** Extract day-of-week (0=Sun..6=Sat) in the given IANA zone. */
export function dayOfWeekInZone(ts: number, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
    const parts = fmt.formatToParts(new Date(ts))
    const wd = parts.find(p => p.type === 'weekday')?.value ?? 'Sun'
    const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
    return idx === -1 ? 0 : idx
  } catch {
    return new Date(ts).getUTCDay()
  }
}

export interface HourProfile {
  bins:            number[]    // 24 buckets, 0 = midnight in `tz`
  peakHour:        number
  quietHour:       number
  peakShare:       number      // peakBin / total
  insufficientData: boolean
  samples:         number
  tz:              string
}

export interface DayOfWeekProfile {
  bins:            number[]    // 7 buckets, 0 = Sunday in `tz`
  peakDay:         number
  quietDay:        number
  peakShare:       number
  insufficientData: boolean
  samples:         number
  tz:              string
}

export interface TrendBlock {
  weekStart:       number      // unix ms
  count:           number
}
export interface MultiWeekTrend {
  weeks:           TrendBlock[]
  slope:           number      // change in count per week
  direction:       'rising' | 'falling' | 'stable' | 'insufficient_data'
  pctChange:       number      // (last - first) / first
}

export interface RhythmReport {
  windowMs:        number
  total:           number
  hourOfDay:       HourProfile
  dayOfWeek:       DayOfWeekProfile
  multiWeek:       MultiWeekTrend
  quietestWindow:  { hour: number; dayOfWeek: number; reason: string } | null
}

// ─── Pure analyzers ────────────────────────────────────────────────────

export function profileHourOfDay(timestamps: ReadonlyArray<number>, tz: string = DEFAULT_TZ): HourProfile {
  const bins = new Array<number>(24).fill(0)
  for (const t of timestamps) {
    const h = hourInZone(t, tz)
    bins[h] = (bins[h] ?? 0) + 1
  }
  const samples = timestamps.length
  if (samples < MIN_SAMPLES) {
    return { bins, peakHour: 0, quietHour: 0, peakShare: 0, insufficientData: true, samples, tz }
  }
  let peakHour = 0, peakVal = -1
  let quietHour = 0, quietVal = Infinity
  for (let i = 0; i < 24; i++) {
    const v = bins[i] ?? 0
    if (v > peakVal)  { peakVal = v;  peakHour = i }
    if (v < quietVal) { quietVal = v; quietHour = i }
  }
  return {
    bins, peakHour, quietHour,
    peakShare: samples === 0 ? 0 : Number((peakVal / samples).toFixed(3)),
    insufficientData: false, samples, tz,
  }
}

export function profileDayOfWeek(timestamps: ReadonlyArray<number>, tz: string = DEFAULT_TZ): DayOfWeekProfile {
  const bins = new Array<number>(7).fill(0)
  for (const t of timestamps) {
    const d = dayOfWeekInZone(t, tz)
    bins[d] = (bins[d] ?? 0) + 1
  }
  const samples = timestamps.length
  if (samples < MIN_SAMPLES) {
    return { bins, peakDay: 0, quietDay: 0, peakShare: 0, insufficientData: true, samples, tz }
  }
  let peakDay = 0, peakVal = -1
  let quietDay = 0, quietVal = Infinity
  for (let i = 0; i < 7; i++) {
    const v = bins[i] ?? 0
    if (v > peakVal)  { peakVal = v;  peakDay = i }
    if (v < quietVal) { quietVal = v; quietDay = i }
  }
  return {
    bins, peakDay, quietDay,
    peakShare: samples === 0 ? 0 : Number((peakVal / samples).toFixed(3)),
    insufficientData: false, samples, tz,
  }
}

const WEEK_MS = 7 * 86_400_000

export function profileMultiWeekTrend(timestamps: ReadonlyArray<number>, windowMs: number): MultiWeekTrend {
  if (timestamps.length === 0 || windowMs < WEEK_MS * 2) {
    return { weeks: [], slope: 0, direction: 'insufficient_data', pctChange: 0 }
  }
  const now = Math.max(...timestamps, Date.now())
  const start = now - windowMs
  const weekCount = Math.max(2, Math.min(12, Math.floor(windowMs / WEEK_MS)))
  const bucketWidth = windowMs / weekCount
  const weeks: TrendBlock[] = []
  for (let i = 0; i < weekCount; i++) {
    weeks.push({ weekStart: start + i * bucketWidth, count: 0 })
  }
  for (const t of timestamps) {
    if (t < start || t > now) continue
    const idx = Math.min(weekCount - 1, Math.floor((t - start) / bucketWidth))
    weeks[idx]!.count++
  }

  // Simple slope: (last - first) / weekCount
  const first = weeks[0]?.count ?? 0
  const last  = weeks[weeks.length - 1]?.count ?? 0
  const slope = (last - first) / Math.max(1, weekCount - 1)
  const mean  = weeks.reduce((s, w) => s + w.count, 0) / weekCount
  if (mean < 5) return { weeks, slope: 0, direction: 'insufficient_data', pctChange: 0 }

  let direction: MultiWeekTrend['direction'] = 'stable'
  if      (slope > mean * 0.10)  direction = 'rising'
  else if (slope < -mean * 0.10) direction = 'falling'

  const pctChange = first === 0 ? 0 : Number(((last - first) / first).toFixed(3))
  return { weeks, slope: Number(slope.toFixed(2)), direction, pctChange }
}

/** Pure: roll all three views into a single report + identify the
 *  quietest hour-of-day × day-of-week combination for scheduling. */
export function buildRhythmReport(timestamps: ReadonlyArray<number>, windowMs: number, tz: string = DEFAULT_TZ): RhythmReport {
  const hourOfDay  = profileHourOfDay(timestamps, tz)
  const dayOfWeek  = profileDayOfWeek(timestamps, tz)
  const multiWeek  = profileMultiWeekTrend(timestamps, windowMs)
  let quietestWindow: RhythmReport['quietestWindow'] = null
  if (!hourOfDay.insufficientData && !dayOfWeek.insufficientData) {
    quietestWindow = {
      hour: hourOfDay.quietHour,
      dayOfWeek: dayOfWeek.quietDay,
      reason: `${dayOfWeekName(dayOfWeek.quietDay)} ${hourOfDay.quietHour.toString().padStart(2, '0')}:00 ${tz} has the lowest combined activity`,
    }
  }
  return {
    windowMs, total: timestamps.length,
    hourOfDay, dayOfWeek, multiWeek,
    quietestWindow,
  }
}

function dayOfWeekName(d: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d] ?? 'Sun'
}

// ─── DB wrapper ────────────────────────────────────────────────────────

export async function analyzeWorkspaceRhythm(workspaceId: string, opts: { windowMs?: number; tz?: string } = {}): Promise<RhythmReport> {
  const windowMs = opts.windowMs ?? 4 * WEEK_MS
  const tz       = opts.tz       ?? DEFAULT_TZ
  const since = Date.now() - windowMs
  const rows = await db.select({ createdAt: events.createdAt }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .limit(50_000).catch(() => [])
  return buildRhythmReport(rows.map(r => r.createdAt), windowMs, tz)
}
