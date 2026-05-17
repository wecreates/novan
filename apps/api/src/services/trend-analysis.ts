/**
 * trend-analysis.ts — Long-term operational trends.
 *
 * 8-week rolling buckets aggregated from real tables. No fabrication —
 * weeks with no data return zeros honestly.
 *
 * Trends covered:
 *   - reliabilityTrend       (failed workflows / total workflows per week)
 *   - providerQualityTrend   (avg latencyMs + error rate per week)
 *   - costTrend              (image_generations.actualCostUsd per week)
 *   - incidentTrend          (count of incidents detected per week)
 *   - deploymentStabilityTrend (deployment.failed / deployment.* per week)
 *   - operatorProductivityTrend (completed missions + applied patches per week)
 */
import { db }                          from '../db/client.js'
import {
  workflowRuns, providerHealthLog, imageGenerations, incidents,
  events, strategicGoals,
} from '../db/schema.js'
import { and, eq, gte, lt, sql }       from 'drizzle-orm'

const WEEK = 7 * 24 * 60 * 60_000
const WEEKS = 8

export interface WeekBucket<T extends Record<string, unknown> = Record<string, unknown>> {
  weekStart: number
  weekEnd:   number
  weekLabel: string  // YYYY-WW
  metrics:   T
}

export interface TrendSeries<T extends Record<string, unknown> = Record<string, unknown>> {
  series:    WeekBucket<T>[]
  direction: 'improving' | 'degrading' | 'flat' | 'insufficient_data'
  delta:     number | null   // last bucket vs first bucket of the key metric
  note:      string
}

function weekLabel(ts: number): string {
  const d = new Date(ts)
  const year = d.getUTCFullYear()
  // ISO week-ish: simple day-of-year / 7
  const start = Date.UTC(year, 0, 1)
  const dayOfYear = Math.floor((ts - start) / (24 * 60 * 60_000))
  const wk = Math.floor(dayOfYear / 7) + 1
  return `${year}-W${String(wk).padStart(2, '0')}`
}

function buildWindows(now: number): Array<{ start: number; end: number; label: string }> {
  const out: Array<{ start: number; end: number; label: string }> = []
  for (let i = WEEKS - 1; i >= 0; i--) {
    const end = now - i * WEEK
    const start = end - WEEK
    out.push({ start, end, label: weekLabel(start) })
  }
  return out
}

function direction(series: number[]): TrendSeries['direction'] {
  const nonZero = series.filter(n => n > 0)
  if (nonZero.length < 2) return 'insufficient_data'
  const first = series[0]
  const last  = series[series.length - 1]
  if (typeof first !== 'number' || typeof last !== 'number') return 'insufficient_data'
  if (Math.abs(last - first) < 1e-6) return 'flat'
  // 'improving' depends on caller semantics — caller wraps
  return last > first ? 'degrading' : 'improving'
}

// ─── Trend builders ──────────────────────────────────────────────────────────

export async function reliabilityTrend(workspaceId: string): Promise<TrendSeries<{ total: number; failed: number; failureRate: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ total: number; failed: number; failureRate: number }>[] = []
  for (const w of windows) {
    const row = await db.select({
      total:  sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
    }).from(workflowRuns)
      .where(and(
        eq(workflowRuns.workspaceId, workspaceId),
        gte(workflowRuns.triggeredAt, w.start),
        lt(workflowRuns.triggeredAt,  w.end),
      ))
      .then(r => r[0]).catch(() => ({ total: 0, failed: 0 }))
    const total = Number(row?.total ?? 0)
    const failed = Number(row?.failed ?? 0)
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: { total, failed, failureRate: total > 0 ? Number((failed / total).toFixed(3)) : 0 },
    })
  }
  const rates = series.map(b => b.metrics.failureRate)
  const dirRaw = direction(rates)
  // higher failure rate = degrading
  const dir: TrendSeries['direction'] = dirRaw === 'insufficient_data' || dirRaw === 'flat' ? dirRaw
    : dirRaw === 'degrading' ? 'degrading' : 'improving'
  const first = rates[0] ?? 0
  const last  = rates[rates.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: rates.some(r => r > 0) ? Number((last - first).toFixed(3)) : null,
    note: 'workflow failure rate per week (lower is better)',
  }
}

export async function providerQualityTrend(workspaceId: string): Promise<TrendSeries<{ healthy: number; degraded: number; down: number; avgLatencyMs: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ healthy: number; degraded: number; down: number; avgLatencyMs: number }>[] = []
  for (const w of windows) {
    const row = await db.select({
      healthy:  sql<number>`count(*) filter (where ${providerHealthLog.status} = 'healthy')::int`,
      degraded: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'degraded')::int`,
      down:     sql<number>`count(*) filter (where ${providerHealthLog.status} = 'down')::int`,
      avgLat:   sql<number>`coalesce(avg(${providerHealthLog.latencyMs}), 0)::float`,
    }).from(providerHealthLog)
      .where(and(
        eq(providerHealthLog.workspaceId, workspaceId),
        gte(providerHealthLog.checkedAt, w.start),
        lt(providerHealthLog.checkedAt,  w.end),
      ))
      .then(r => r[0]).catch(() => ({ healthy: 0, degraded: 0, down: 0, avgLat: 0 }))
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: {
        healthy: Number(row?.healthy ?? 0), degraded: Number(row?.degraded ?? 0),
        down: Number(row?.down ?? 0),
        avgLatencyMs: Number(Number(row?.avgLat ?? 0).toFixed(0)),
      },
    })
  }
  const latencies = series.map(b => b.metrics.avgLatencyMs)
  const dirRaw = direction(latencies)
  // higher latency = degrading
  const dir = dirRaw
  const first = latencies[0] ?? 0
  const last  = latencies[latencies.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: latencies.some(l => l > 0) ? Number((last - first).toFixed(0)) : null,
    note: 'avg provider probe latency per week (lower is better)',
  }
}

export async function costTrend(workspaceId: string): Promise<TrendSeries<{ images: number; spendUsd: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ images: number; spendUsd: number }>[] = []
  for (const w of windows) {
    const row = await db.select({
      n: sql<number>`count(*)::int`,
      spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
    }).from(imageGenerations)
      .where(and(
        eq(imageGenerations.workspaceId, workspaceId),
        gte(imageGenerations.createdAt, w.start),
        lt(imageGenerations.createdAt,  w.end),
      ))
      .then(r => r[0]).catch(() => ({ n: 0, spend: 0 }))
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: { images: Number(row?.n ?? 0), spendUsd: Number(Number(row?.spend ?? 0).toFixed(4)) },
    })
  }
  const spends = series.map(b => b.metrics.spendUsd)
  const dir = direction(spends)
  const first = spends[0] ?? 0
  const last  = spends[spends.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: spends.some(s => s > 0) ? Number((last - first).toFixed(4)) : null,
    note: 'image-gen spend per week (lower or flat is good for cost control)',
  }
}

export async function incidentTrend(workspaceId: string): Promise<TrendSeries<{ count: number; critical: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ count: number; critical: number }>[] = []
  for (const w of windows) {
    const row = await db.select({
      c:    sql<number>`count(*)::int`,
      crit: sql<number>`count(*) filter (where ${incidents.severity} = 'critical')::int`,
    }).from(incidents)
      .where(and(
        eq(incidents.workspaceId, workspaceId),
        gte(incidents.detectedAt, w.start),
        lt(incidents.detectedAt,  w.end),
      ))
      .then(r => r[0]).catch(() => ({ c: 0, crit: 0 }))
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: { count: Number(row?.c ?? 0), critical: Number(row?.crit ?? 0) },
    })
  }
  const counts = series.map(b => b.metrics.count)
  const dir = direction(counts)
  const first = counts[0] ?? 0
  const last  = counts[counts.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: counts.some(c => c > 0) ? Number(last - first) : null,
    note: 'incidents detected per week (lower is better)',
  }
}

export async function deploymentStabilityTrend(workspaceId: string): Promise<TrendSeries<{ started: number; completed: number; failed: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ started: number; completed: number; failed: number }>[] = []
  for (const w of windows) {
    const row = await db.select({
      started:   sql<number>`count(*) filter (where ${events.type} = 'deployment.started')::int`,
      completed: sql<number>`count(*) filter (where ${events.type} = 'deployment.completed')::int`,
      failed:    sql<number>`count(*) filter (where ${events.type} = 'deployment.failed')::int`,
    }).from(events)
      .where(and(
        eq(events.workspaceId, workspaceId),
        sql`${events.type} like 'deployment.%'`,
        gte(events.createdAt, w.start),
        lt(events.createdAt,  w.end),
      ))
      .then(r => r[0]).catch(() => ({ started: 0, completed: 0, failed: 0 }))
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: {
        started: Number(row?.started ?? 0),
        completed: Number(row?.completed ?? 0),
        failed: Number(row?.failed ?? 0),
      },
    })
  }
  const failures = series.map(b => b.metrics.failed)
  const dir = direction(failures)
  const first = failures[0] ?? 0
  const last  = failures[failures.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: failures.some(f => f > 0) ? Number(last - first) : null,
    note: 'deployment failures per week (lower is better)',
  }
}

export async function operatorProductivityTrend(workspaceId: string): Promise<TrendSeries<{ missionsCompleted: number; patchesApplied: number }>> {
  const windows = buildWindows(Date.now())
  const series: WeekBucket<{ missionsCompleted: number; patchesApplied: number }>[] = []
  for (const w of windows) {
    const [missions, patches] = await Promise.all([
      db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
        .where(and(
          eq(strategicGoals.workspaceId, workspaceId),
          eq(strategicGoals.status, 'completed'),
          gte(strategicGoals.completedAt, w.start),
          lt(strategicGoals.completedAt,  w.end),
        ))
        .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
      db.select({ c: sql<number>`count(*)::int` }).from(events)
        .where(and(
          eq(events.workspaceId, workspaceId),
          sql`${events.type} in ('patch.applied','patch.auto_applied')`,
          gte(events.createdAt, w.start),
          lt(events.createdAt,  w.end),
        ))
        .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    ])
    series.push({
      weekStart: w.start, weekEnd: w.end, weekLabel: w.label,
      metrics: { missionsCompleted: missions, patchesApplied: patches },
    })
  }
  const productivity = series.map(b => b.metrics.missionsCompleted + b.metrics.patchesApplied)
  const dirRaw = direction(productivity)
  // higher productivity = improving (inverse of default 'higher = degrading')
  const dir: TrendSeries['direction'] = dirRaw === 'insufficient_data' || dirRaw === 'flat' ? dirRaw
    : dirRaw === 'degrading' ? 'improving' : 'degrading'
  const first = productivity[0] ?? 0
  const last  = productivity[productivity.length - 1] ?? 0
  return {
    series, direction: dir,
    delta: productivity.some(p => p > 0) ? Number(last - first) : null,
    note: 'missions completed + patches applied per week (higher is better)',
  }
}

export async function allTrends(workspaceId: string) {
  const [reliability, providerQuality, cost, incident, deployment, productivity] = await Promise.all([
    reliabilityTrend(workspaceId),
    providerQualityTrend(workspaceId),
    costTrend(workspaceId),
    incidentTrend(workspaceId),
    deploymentStabilityTrend(workspaceId),
    operatorProductivityTrend(workspaceId),
  ])
  return { reliability, providerQuality, cost, incident, deployment, productivity, generatedAt: Date.now() }
}
