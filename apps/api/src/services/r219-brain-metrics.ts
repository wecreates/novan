/**
 * R146.219 — Brain metrics surface. One brain op (brain.metrics) returns
 * the operator-visible state of the capability layer for the /brain.html
 * v2 dashboard tab:
 *
 *   - Skill leaderboard: name, uses, wins, win-rate, Thompson median sample
 *   - Recent outcomes: per pick — what skill, picker (thompson|llm), won, cost
 *   - HTTP route latency p50/p95/p99 from the histogram
 *   - Provider chain health per task type
 *   - 24h cost rollup by provider + task type
 *   - Memory + chapter + hook + schedule counts (R211-R214)
 */
import { db } from '../db/client.js'
import { operatorSkills, skillOutcomes, aiUsage } from '../db/schema.js'
import { and, eq, desc, sql, gte } from 'drizzle-orm'

export interface BrainMetrics {
  generatedAt: number
  skills: Array<{ name: string; uses: number; wins: number; winRate: number; description: string }>
  recentOutcomes: Array<{ skillName: string; picker: string; won: boolean | null; costUsd: number; stepsUsed: number; createdAt: number }>
  routing: Array<{ task: string; chain: string[] }>
  cost24h: Array<{ provider: string; calls: number; costUsd: number }>
  http: { snapshotsTotal: number; p50?: number; p95?: number; p99?: number }
  workplace: {
    memories: number; chapters: number; hooks: number; schedules: number;
    spawnTasks: number; pendingQuestions: number; connectors: number;
  }
}

export async function brainMetrics(workspaceId: string): Promise<BrainMetrics> {
  // Skill leaderboard sorted by wins desc, uses desc
  const skillRows = await db.select({
    name: operatorSkills.name, uses: operatorSkills.uses, wins: operatorSkills.wins,
    description: operatorSkills.description,
  }).from(operatorSkills).where(eq(operatorSkills.workspaceId, workspaceId))
    .orderBy(desc(operatorSkills.wins), desc(operatorSkills.uses)).limit(25)
  const skills = skillRows.map(r => ({
    name: r.name, uses: r.uses, wins: r.wins,
    winRate: r.uses > 0 ? Number((r.wins / r.uses).toFixed(3)) : 0,
    description: r.description,
  }))

  // Recent outcomes (last 20)
  const outcomes = await db.select({
    skillName: skillOutcomes.skillName, picker: skillOutcomes.picker,
    won: skillOutcomes.won, costUsd: skillOutcomes.costUsd,
    stepsUsed: skillOutcomes.stepsUsed, createdAt: skillOutcomes.createdAt,
  }).from(skillOutcomes).where(eq(skillOutcomes.workspaceId, workspaceId))
    .orderBy(desc(skillOutcomes.createdAt)).limit(20)

  // Cost 24h rollup
  const since24 = Date.now() - 24 * 60 * 60_000
  const costRows = await db.select({
    provider: aiUsage.provider,
    calls: sql<number>`count(*)::int`,
    costUsd: sql<number>`SUM(${aiUsage.costUsd})::float`,
  }).from(aiUsage).where(gte(aiUsage.timestamp, since24)).groupBy(aiUsage.provider)
    .orderBy(desc(sql`SUM(${aiUsage.costUsd})`))

  // Routing health snapshot (R216)
  let routing: Array<{ task: string; chain: string[] }> = []
  try {
    const { routingHealthSnapshot } = await import('./r216-routing.js')
    routing = await routingHealthSnapshot()
  } catch { /* tolerated */ }

  // Workplace counts (R214 helper)
  let workplace = {
    memories: 0, chapters: 0, hooks: 0, schedules: 0,
    spawnTasks: 0, pendingQuestions: 0, connectors: 0,
  }
  try {
    const { workplaceCounts } = await import('./r211-workplace.js')
    workplace = await workplaceCounts(workspaceId)
  } catch { /* tolerated */ }

  // HTTP latency snapshot — read raw histogram counts
  let http: BrainMetrics['http'] = { snapshotsTotal: 0 }
  try {
    const { renderMetrics } = await import('./metrics.js')
    const text = renderMetrics()
    const result = parseLatencyPercentiles(text)
    http = result
  } catch { /* tolerated */ }

  return {
    generatedAt: Date.now(),
    skills,
    recentOutcomes: outcomes.map(o => ({
      skillName: o.skillName, picker: o.picker,
      won: o.won,
      costUsd: Number(o.costUsd ?? 0),
      stepsUsed: o.stepsUsed,
      createdAt: o.createdAt,
    })),
    routing,
    cost24h: costRows.map(c => ({
      provider: c.provider,
      calls: Number(c.calls),
      costUsd: Number((c.costUsd ?? 0).toFixed(4)),
    })),
    http,
    workplace,
  }
}

/** Parse Prometheus-format histogram output, return aggregate p50/p95/p99
 *  across all routes. Coarse — uses bucket-midpoint interpolation. */
function parseLatencyPercentiles(metricsText: string): BrainMetrics['http'] {
  const lines = metricsText.split('\n').filter(l => l.startsWith('http_request_duration_ms_bucket'))
  if (lines.length === 0) return { snapshotsTotal: 0 }
  // Aggregate buckets across labels
  const aggregate = new Map<number, number>()  // bucket-le → cumulative count
  for (const l of lines) {
    const m = l.match(/le="([^"]+)"\}\s+(\d+(?:\.\d+)?)/)
    if (!m) continue
    const le = m[1] === '+Inf' ? Infinity : Number(m[1])
    if (!isFinite(le) && le !== Infinity) continue
    const count = Number(m[2])
    aggregate.set(le, (aggregate.get(le) ?? 0) + count)
  }
  if (aggregate.size === 0) return { snapshotsTotal: 0 }
  const sorted = [...aggregate.entries()].sort((a, b) => a[0] - b[0])
  const total = sorted[sorted.length - 1]?.[1] ?? 0
  if (total === 0) return { snapshotsTotal: 0 }
  const pick = (q: number): number => {
    const target = total * q
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i]![1] >= target) return sorted[i]![0]
    }
    return sorted[sorted.length - 1]![0]
  }
  return {
    snapshotsTotal: total,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  }
}
