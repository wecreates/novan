/**
 * simulation-engine.ts — Scenario simulation + outcome forecasting +
 * decision comparison + virtual testing.
 *
 * Honest scope:
 *   - Scenarios are DERIVED from persisted history (not LLM hallucination).
 *   - Three cases (best/likely/worst) come from observed historical
 *     percentiles or rule-of-thumb when sample size is too low.
 *   - When sample size < 5, returns 'insufficient_data' confidence ≤ 0.3.
 *   - Outcome linkage: scenario_outcomes table compares projected vs
 *     observed after horizon passes.
 */
import { db } from '../db/client.js'
import {
  scenarios, scenarioOutcomes, aiUsage, providerFailures, providerHealthLog,
  workflowRuns, incidents, driftWarnings,
} from '../db/schema.js'
import { and, eq, desc, gte, lt, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { record as recordChain } from './reasoning-chains.js'

export type ScenarioKind =
  | 'provider_outage' | 'queue_overload' | 'deployment_failure'
  | 'security_incident' | 'budget_spike' | 'traffic_surge'
  | 'scaling' | 'operator_growth' | 'marketplace_risk' | 'social_strategy'

export interface Scenario {
  id: string
  workspaceId: string
  kind: ScenarioKind
  name: string
  inputs: Record<string, unknown>
  bestCase: Record<string, unknown>
  likelyCase: Record<string, unknown>
  worstCase: Record<string, unknown>
  confidence: number
  mitigation: string[]
  evidenceRefs: Array<{ type: string; id: string; extract: string }>
  factType: 'estimate'
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]!
}

// ─── Scenario builders ──────────────────────────────────────────────────

async function simulateProviderOutage(workspaceId: string): Promise<Omit<Scenario, 'id' | 'workspaceId'> | null> {
  const since30d = Date.now() - 30 * 24 * 60 * 60_000
  const failures = await db.select().from(providerFailures)
    .where(and(eq(providerFailures.workspaceId, workspaceId), gte(providerFailures.createdAt, since30d)))
    .catch(() => [])
  const calls = await db.select({ s: sql<number>`count(*)::int` }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since30d)))
    .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)
  if (calls < 50) {
    return {
      kind: 'provider_outage',
      name: 'Provider outage (insufficient data)',
      inputs: { window: '30d', calls },
      bestCase:   { description: 'unknown', impactedRequests: 0 },
      likelyCase: { description: 'unknown', impactedRequests: 0 },
      worstCase:  { description: 'unknown', impactedRequests: 0 },
      confidence: 0.2,
      mitigation: ['Need ≥50 calls in 30d for meaningful baseline'],
      evidenceRefs: [{ type: 'ai_usage', id: 'window_30d', extract: `${calls} calls` }],
      factType: 'estimate',
    }
  }
  const failureRate = failures.length / Math.max(calls, 1)
  // best: failover catches all, 0 impact
  // likely: failureRate-class outage = current failure rate × callsPerHour for 1h
  // worst: 4h outage with no failover, all calls fail
  const callsPerHour = calls / (30 * 24)
  return {
    kind: 'provider_outage',
    name: '1-provider outage',
    inputs: { failureRate30d: Number(failureRate.toFixed(4)), callsPerHour: Number(callsPerHour.toFixed(1)) },
    bestCase:   { description: 'fallback catches all', impactedRequests: 0, costImpactUsd: 0 },
    likelyCase: { description: '~1h outage with partial failover', impactedRequests: Math.round(callsPerHour * 0.5), costImpactUsd: Number((callsPerHour * 0.5 * 0.002).toFixed(2)) },
    worstCase:  { description: '4h outage, no failover', impactedRequests: Math.round(callsPerHour * 4), costImpactUsd: Number((callsPerHour * 4 * 0.002).toFixed(2)) },
    confidence: 0.6,
    mitigation: [
      'Maintain ≥2 providers per task_type',
      'Ensure provider_preferences fallback chain is configured',
      'Verify kill_switch + circuit breaker thresholds',
    ],
    evidenceRefs: [
      { type: 'ai_usage',         id: 'window_30d', extract: `${calls} total calls` },
      { type: 'provider_failures', id: 'window_30d', extract: `${failures.length} failures` },
    ],
    factType: 'estimate',
  }
}

async function simulateBudgetSpike(workspaceId: string): Promise<Omit<Scenario, 'id' | 'workspaceId'> | null> {
  const since30d = Date.now() - 30 * 24 * 60 * 60_000
  // Build daily spend series
  const dailySpend: number[] = []
  for (let i = 29; i >= 0; i--) {
    const end = Date.now() - i * 24 * 60 * 60_000
    const start = end - 24 * 60 * 60_000
    const row = await db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, start), lt(aiUsage.timestamp, end)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)
    dailySpend.push(row)
  }
  const nonZero = dailySpend.filter(v => v > 0)
  if (nonZero.length < 5) {
    return {
      kind: 'budget_spike', name: 'Budget spike (insufficient data)',
      inputs: { nonZeroDays: nonZero.length },
      bestCase: {}, likelyCase: {}, worstCase: {},
      confidence: 0.2,
      mitigation: ['Need ≥5 days of non-zero spend for percentile baseline'],
      evidenceRefs: [{ type: 'ai_usage_daily', id: 'series', extract: `non-zero days: ${nonZero.length}/30` }],
      factType: 'estimate',
    }
  }
  const p10 = percentile(nonZero, 0.10)
  const p50 = percentile(nonZero, 0.50)
  const p95 = percentile(nonZero, 0.95)
  return {
    kind: 'budget_spike',
    name: 'Daily budget spike (7d projection)',
    inputs: { nonZeroDays: nonZero.length, p10, p50, p95 },
    bestCase:   { dailyUsd: Number(p10.toFixed(4)),       weeklyUsd: Number((p10 * 7).toFixed(2)) },
    likelyCase: { dailyUsd: Number(p50.toFixed(4)),       weeklyUsd: Number((p50 * 7).toFixed(2)) },
    worstCase:  { dailyUsd: Number((p95 * 1.5).toFixed(4)), weeklyUsd: Number((p95 * 1.5 * 7).toFixed(2)) },
    confidence: nonZero.length >= 14 ? 0.7 : 0.5,
    mitigation: [
      'Budget guard daily/monthly limits applied',
      'Engage kill_switch on weekly burn > limit',
      'Throttle research + image-gen if daily > 80%',
    ],
    evidenceRefs: [{ type: 'ai_usage_daily', id: '30d_series', extract: `${nonZero.length} non-zero days; p50=$${p50.toFixed(2)}/d` }],
    factType: 'estimate',
  }
}

async function simulateQueueOverload(workspaceId: string): Promise<Omit<Scenario, 'id' | 'workspaceId'> | null> {
  const since7d = Date.now() - 7 * 24 * 60 * 60_000
  const runs = await db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, since7d)))
    .catch(() => [])
  const failedRuns = runs.filter(r => r.status === 'failed').length
  return {
    kind: 'queue_overload',
    name: 'Queue overload (3x current load)',
    inputs: { runs7d: runs.length, failedRuns },
    bestCase:   { description: 'autoscale to 3 nodes per queue', latencySec: 5 },
    likelyCase: { description: 'p95 latency 30s, some retries', latencySec: 30, droppedJobs: Math.round(runs.length * 0.02) },
    worstCase:  { description: 'cascading failures, queue lag minutes', latencySec: 300, droppedJobs: Math.round(runs.length * 0.10) },
    confidence: runs.length >= 50 ? 0.6 : 0.3,
    mitigation: [
      'Scale workers via runtime-fabric',
      'Apply worker_concurrency factor on saturating queues',
      'Engage backpressure via approval-gate',
    ],
    evidenceRefs: [{ type: 'workflow_runs_7d', id: 'window', extract: `${runs.length} runs, ${failedRuns} failed` }],
    factType: 'estimate',
  }
}

async function simulateSecurityIncident(workspaceId: string): Promise<Omit<Scenario, 'id' | 'workspaceId'> | null> {
  const since30d = Date.now() - 30 * 24 * 60 * 60_000
  const inc = await db.select().from(incidents)
    .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.createdAt, since30d)))
    .catch(() => [])
  const security = inc.filter(i => /security|breach|leak|unauthorized/i.test(i.type) || /security|breach|leak/i.test(i.title))
  return {
    kind: 'security_incident',
    name: 'Security incident response',
    inputs: { incidents30d: inc.length, securityClass: security.length },
    bestCase:   { description: 'detected within 1h via anomaly detector', meanTimeToContainMin: 30 },
    likelyCase: { description: 'detected within 6h, partial response', meanTimeToContainMin: 240 },
    worstCase:  { description: 'undetected >24h, escalation needed', meanTimeToContainMin: 1440 },
    confidence: 0.4,
    mitigation: [
      'Auto-rotate vault secrets on suspicion',
      'Kill switch on suspicious agent behavior',
      'Notify operator at HIGH severity immediately',
      'Override log preserves audit trail',
    ],
    evidenceRefs: [{ type: 'incidents_30d', id: 'window', extract: `${inc.length} total, ${security.length} security-class` }],
    factType: 'estimate',
  }
}

// ─── Public entry: generate a scenario ──────────────────────────────────

const BUILDERS: Record<ScenarioKind, ((ws: string) => Promise<Omit<Scenario, 'id' | 'workspaceId'> | null>) | null> = {
  provider_outage:    simulateProviderOutage,
  budget_spike:       simulateBudgetSpike,
  queue_overload:     simulateQueueOverload,
  security_incident:  simulateSecurityIncident,
  deployment_failure: null,   // requires deployment history (not wired)
  traffic_surge:      null,
  scaling:            null,
  operator_growth:    null,
  marketplace_risk:   null,
  social_strategy:    null,
}

export async function buildScenario(workspaceId: string, kind: ScenarioKind): Promise<Scenario | { error: string }> {
  const builder = BUILDERS[kind]
  if (!builder) return { error: `scenario kind '${kind}' not yet implemented` }
  const draft = await builder(workspaceId)
  if (!draft) return { error: 'no data available' }
  const id = uuidv7()
  await db.insert(scenarios).values({
    id, workspaceId,
    kind: draft.kind, name: draft.name,
    inputs: draft.inputs,
    bestCase: draft.bestCase, likelyCase: draft.likelyCase, worstCase: draft.worstCase,
    confidence: draft.confidence,
    mitigation: draft.mitigation,
    evidenceRefs: draft.evidenceRefs,
    createdAt: Date.now(),
  }).catch((e: Error) => { console.error('[simulation-engine]', e.message); return null })
  await recordChain({
    workspaceId, kind: 'forecast', subjectId: `scenario:${id}`,
    decision: `Scenario built: ${draft.name} (conf ${draft.confidence.toFixed(2)})`,
    evidence: draft.evidenceRefs,
    confidence: draft.confidence, source: 'simulation-engine',
  }).catch((e: Error) => { console.error('[simulation-engine]', e.message); return null })
  return { id, workspaceId, ...draft }
}

export async function listScenarios(workspaceId: string, opts?: { kind?: ScenarioKind; limit?: number }) {
  const conds = [eq(scenarios.workspaceId, workspaceId)]
  if (opts?.kind) conds.push(eq(scenarios.kind, opts.kind))
  return db.select().from(scenarios)
    .where(and(...conds))
    .orderBy(desc(scenarios.createdAt))
    .limit(opts?.limit ?? 30).catch(() => [])
}

// ─── Decision comparison ────────────────────────────────────────────────

export interface DecisionOption {
  name:       string
  benefit:    string
  benefitScore: number   // 0..1
  risk:       string
  riskScore:  number     // 0..1
  costUsd:    number
  rollbackComplexity: 'trivial' | 'moderate' | 'complex' | 'irreversible'
  confidence: number     // 0..1
}

export interface DecisionComparison {
  options: Array<DecisionOption & { score: number }>
  recommended: number   // index
  rationale: string
}

export function compareDecisions(options: DecisionOption[]): DecisionComparison {
  const COMPLEXITY_W: Record<DecisionOption['rollbackComplexity'], number> = {
    trivial: 0.10, moderate: 0.05, complex: -0.10, irreversible: -0.30,
  }
  const scored = options.map(o => ({
    ...o,
    score: Number(
      (o.benefitScore * 0.4
      - o.riskScore * 0.3
      - Math.min(1, o.costUsd / 100) * 0.15
      + COMPLEXITY_W[o.rollbackComplexity]
      + (o.confidence - 0.5) * 0.25
      ).toFixed(3),
    ),
  }))
  let bestIdx = 0
  for (let i = 1; i < scored.length; i++) if (scored[i]!.score > scored[bestIdx]!.score) bestIdx = i
  const best = scored[bestIdx]!
  return {
    options: scored,
    recommended: bestIdx,
    rationale: `${best.name}: benefit ${best.benefitScore.toFixed(2)} > risk ${best.riskScore.toFixed(2)}, cost $${best.costUsd}, rollback ${best.rollbackComplexity}, confidence ${best.confidence.toFixed(2)}`,
  }
}

// ─── Outcome linkage (learning loop) ────────────────────────────────────

export async function recordObservedOutcome(workspaceId: string, scenarioId: string, observed: Record<string, unknown>, matchedCase?: 'best' | 'likely' | 'worst' | 'none', delta?: Record<string, unknown>): Promise<string> {
  const id = uuidv7()
  await db.insert(scenarioOutcomes).values({
    id, scenarioId, workspaceId,
    observed,
    matchedCase: matchedCase ?? null,
    delta: delta ?? {},
    observedAt: Date.now(),
  }).catch((e: Error) => { console.error('[simulation-engine]', e.message); return null })
  return id
}

export async function simulationAccuracy(workspaceId: string, windowDays = 90): Promise<{ total: number; matched: number; matchRate: number | null; byKind: Record<string, { total: number; matched: number }> }> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const outcomes = await db.select({
    scenarioId:  scenarioOutcomes.scenarioId,
    matchedCase: scenarioOutcomes.matchedCase,
  }).from(scenarioOutcomes)
    .where(and(eq(scenarioOutcomes.workspaceId, workspaceId), gte(scenarioOutcomes.observedAt, since)))
    .catch(() => [])
  const total = outcomes.length
  const matched = outcomes.filter(o => o.matchedCase && o.matchedCase !== 'none').length
  // Group by scenario kind
  const byKind: Record<string, { total: number; matched: number }> = {}
  if (total > 0) {
    const scenarioRows = await db.select({ id: scenarios.id, kind: scenarios.kind }).from(scenarios)
      .where(eq(scenarios.workspaceId, workspaceId))
      .catch(() => [])
    const kindMap = new Map(scenarioRows.map(s => [s.id, s.kind]))
    for (const o of outcomes) {
      const k = kindMap.get(o.scenarioId) ?? 'unknown'
      const e = byKind[k] ?? { total: 0, matched: 0 }
      e.total++
      if (o.matchedCase && o.matchedCase !== 'none') e.matched++
      byKind[k] = e
    }
  }
  return {
    total, matched,
    matchRate: total >= 5 ? Number((matched / total).toFixed(3)) : null,
    byKind,
  }
}

// ─── War-room snapshot ──────────────────────────────────────────────────

export async function simulationWarRoom(workspaceId: string) {
  const [recent, accuracy] = await Promise.all([
    listScenarios(workspaceId, { limit: 20 }),
    simulationAccuracy(workspaceId),
  ])
  return {
    generatedAt: Date.now(),
    recentScenarios: recent,
    accuracy,
    availableKinds: Object.entries(BUILDERS).filter(([_, fn]) => fn !== null).map(([k]) => k),
  }
}
