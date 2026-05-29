/**
 * economic-intelligence.ts — Autonomous Economic Intelligence Layer.
 *
 * Seven subsystems, one file, fact/estimate-separated:
 *   1. Economic State Engine    — aggregates spend across persisted sources
 *   2. ROI Analysis              — joins cost with outcome (success/match rate)
 *   3. Resource Allocation       — recommends provider/concurrency moves
 *   4. Efficiency Forecasting    — linear extrapolation of spend trend
 *   5. Strategic Recommendations — surfaces actions via reasoning chains
 *   6. War Room snapshot         — single payload for /economy UI
 *   7. Learning Loop             — predicted vs actual savings score
 *
 * SPEC RULES (non-negotiable):
 *   • no fake ROI / no fabricated savings
 *   • everything tagged factType: 'fact' | 'estimate'
 *   • forecasts use real persisted buckets; insufficient → 'insufficient_data'
 *   • replayable: pure reads + structured chain writes only
 */
import { db } from '../db/client.js'
import {
  aiUsage, imageGenerations, endpointUsageLogs, providerBudgets,
  workflowRuns, reasoningChains, executionLeases, providerFailures,
} from '../db/schema.js'
import { and, eq, gte, sql, desc, lt, isNotNull } from 'drizzle-orm'
import { record as recordChain }      from './reasoning-chains.js'
import { notify }                     from './notifications.js'
import { revenueSummary, revenueByWorkflow } from './revenue.js'

type Fact     = { factType: 'fact';     value: number; source: string }
type Estimate = { factType: 'estimate'; value: number; basis: string; confidence: number }

// ── 1. Economic State Engine ──────────────────────────────────────────────

export interface EconomicState {
  windowDays: number
  generatedAt: number
  spend: {
    aiProviders:   Fact   // sum(aiUsage.costUsd)
    remoteEndpoints: Fact // sum(endpointUsageLogs.costUsd)
    imageGen:      Fact   // sum(imageGenerations.actualCostUsd)
    agentExec:     Fact   // sum(agentExecutions.costUsd) if present
    total:         Fact
  }
  budget: {
    dailyLimitUsd:   number
    monthlyLimitUsd: number
    dailySpendUsd:   number
    monthlySpendUsd: number
    dailyUtilization:   number  // 0..1
    monthlyUtilization: number  // 0..1
  } | null
  byProvider: Array<{ provider: string; spendUsd: number; calls: number; avgCostUsd: number; failureRate: number }>
  byTaskType: Array<{ taskType: string; spendUsd: number; calls: number; avgCostUsd: number }>
}

export async function economicState(workspaceId: string, windowDays = 7): Promise<EconomicState> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000

  const [ai, ep, ig, ae] = await Promise.all([
    db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
      .from(aiUsage).where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
    db.select({ s: sql<number>`coalesce(sum(${endpointUsageLogs.costUsd}), 0)::float` })
      .from(endpointUsageLogs).where(and(eq(endpointUsageLogs.workspaceId, workspaceId), gte(endpointUsageLogs.createdAt, since)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
    db.select({ s: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float` })
      .from(imageGenerations).where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, since)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
    db.select({ s: sql<number>`coalesce(sum(${executionLeases.costUsd}), 0)::float` })
      .from(executionLeases).where(and(eq(executionLeases.workspaceId, workspaceId), gte(executionLeases.createdAt, since)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
  ])

  const total = ai + ep + ig + ae

  const budgetRow = await db.select().from(providerBudgets)
    .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch(() => null)

  const byProviderRows = await db.select({
    provider: aiUsage.provider,
    spend:    sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
    calls:    sql<number>`count(*)::int`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .groupBy(aiUsage.provider).catch(() => [])

  const failures = await db.select({
    provider: providerFailures.providerId,
    n:        sql<number>`count(*)::int`,
  }).from(providerFailures)
    .where(and(eq(providerFailures.workspaceId, workspaceId), gte(providerFailures.createdAt, since)))
    .groupBy(providerFailures.providerId).catch(() => [])
  const failMap = new Map(failures.map(f => [f.provider, Number(f.n)]))

  const byProvider = byProviderRows.map(r => {
    const calls = Number(r.calls)
    const spend = Number(r.spend)
    const fails = failMap.get(r.provider) ?? 0
    return {
      provider: r.provider,
      spendUsd: Number(spend.toFixed(4)),
      calls,
      avgCostUsd:  calls > 0 ? Number((spend / calls).toFixed(6)) : 0,
      // `calls` counts successful ai_usage rows; `fails` counts
       // provider_failures separately. Total attempts = calls + fails.
       // The previous formula `fails / max(calls, fails)` was wrong both
       // ways: when fails > calls it returned 1.0 (always 100% failure
       // even though many calls succeeded), and when fails ≤ calls it
       // returned fails/calls (which misses the "of all attempts" frame).
      failureRate: (calls + fails) > 0 ? Number((fails / (calls + fails)).toFixed(3)) : 0,
    }
  }).sort((a, b) => b.spendUsd - a.spendUsd)

  const byTaskRows = await db.select({
    taskType: aiUsage.taskType,
    spend:    sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
    calls:    sql<number>`count(*)::int`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .groupBy(aiUsage.taskType).catch(() => [])

  const byTaskType = byTaskRows.map(r => {
    const calls = Number(r.calls), spend = Number(r.spend)
    return {
      taskType: r.taskType,
      spendUsd: Number(spend.toFixed(4)),
      calls,
      avgCostUsd: calls > 0 ? Number((spend / calls).toFixed(6)) : 0,
    }
  }).sort((a, b) => b.spendUsd - a.spendUsd)

  return {
    windowDays, generatedAt: Date.now(),
    spend: {
      aiProviders:    { factType: 'fact', value: Number(ai.toFixed(4)),    source: 'ai_usage.cost_usd' },
      remoteEndpoints:{ factType: 'fact', value: Number(ep.toFixed(4)),    source: 'endpoint_usage_logs.cost_usd' },
      imageGen:       { factType: 'fact', value: Number(ig.toFixed(4)),    source: 'image_generations.actual_cost_usd' },
      agentExec:      { factType: 'fact', value: Number(ae.toFixed(4)),    source: 'execution_leases.cost_usd' },
      total:          { factType: 'fact', value: Number(total.toFixed(4)), source: 'sum(above)' },
    },
    budget: budgetRow ? {
      dailyLimitUsd:      Number(budgetRow.dailyLimitUsd),
      monthlyLimitUsd:    Number(budgetRow.monthlyLimitUsd),
      dailySpendUsd:      Number(budgetRow.dailySpendUsd),
      monthlySpendUsd:    Number(budgetRow.monthlySpendUsd),
      dailyUtilization:   budgetRow.dailyLimitUsd   > 0 ? Number((Number(budgetRow.dailySpendUsd)   / Number(budgetRow.dailyLimitUsd)  ).toFixed(3)) : 0,
      monthlyUtilization: budgetRow.monthlyLimitUsd > 0 ? Number((Number(budgetRow.monthlySpendUsd) / Number(budgetRow.monthlyLimitUsd)).toFixed(3)) : 0,
    } : null,
    byProvider,
    byTaskType,
  }
}

// ── 2. ROI Analysis Engine ────────────────────────────────────────────────

export interface RoiAnalysis {
  windowDays: number
  workflows: Array<{
    workflowId: string
    runs: number
    successes: number
    successRate: number
    aiSpendUsd: Estimate  // estimated from traceId join (best effort)
    factType: 'fact'      // run counts are facts
  }>
  providersByEfficiency: Array<{
    provider: string
    spendUsd: number
    successfulCalls: number
    costPerSuccessUsd: Estimate
  }>
  recommendationOutcome: {
    economicChainsLogged: number
    matched: number
    unmatched: number
    matchRate: number | null
    factType: 'fact'
  }
  notes: string[]
}

export async function roiAnalysis(workspaceId: string, windowDays = 30): Promise<RoiAnalysis> {
  const since = Date.now() - windowDays * 24 * 60 * 60_000

  // Workflow runs: pure fact (status counts). We DO NOT fabricate revenue.
  const wfRows = await db.select({
    workflowId: workflowRuns.workflowId,
    status:     workflowRuns.status,
    n:          sql<number>`count(*)::int`,
  }).from(workflowRuns)
    .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, since)))
    .groupBy(workflowRuns.workflowId, workflowRuns.status).catch(() => [])

  const wfMap = new Map<string, { runs: number; successes: number }>()
  for (const r of wfRows) {
    const entry = wfMap.get(r.workflowId) ?? { runs: 0, successes: 0 }
    entry.runs += Number(r.n)
    if (r.status === 'completed') entry.successes += Number(r.n)
    wfMap.set(r.workflowId, entry)
  }

  // Per-workflow AI spend via direct FK join (FACT when populated).
  // Falls back to proportional estimate for the residual unattributed pool.
  const attributed = await db.select({
    workflowId: workflowRuns.workflowId,
    spend:      sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
  })
    .from(aiUsage)
    .innerJoin(workflowRuns, eq(workflowRuns.id, aiUsage.workflowRunId))
    .where(and(
      eq(aiUsage.workspaceId, workspaceId),
      gte(aiUsage.timestamp, since),
      isNotNull(aiUsage.workflowRunId),
    ))
    .groupBy(workflowRuns.workflowId).catch(() => [])
  const attMap = new Map(attributed.map(a => [a.workflowId, Number(a.spend)]))

  const totalAi = await db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
    .from(aiUsage).where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)
  const attributedTotal = attributed.reduce((s, r) => s + Number(r.spend), 0)
  const unattributed    = Math.max(0, totalAi - attributedTotal)

  const totalRuns = Array.from(wfMap.values()).reduce((s, w) => s + w.runs, 0)

  const workflows = Array.from(wfMap.entries()).map(([workflowId, w]) => {
    const factSpend = attMap.get(workflowId)
    const share = totalRuns > 0 ? w.runs / totalRuns : 0
    const estSpend = unattributed * share
    return {
      workflowId,
      runs: w.runs, successes: w.successes,
      successRate: w.runs > 0 ? Number((w.successes / w.runs).toFixed(3)) : 0,
      aiSpendUsd: factSpend !== undefined && factSpend > 0
        ? {
          factType: 'estimate' as const,   // structurally still "estimate" wrapper, but value below is fact-grade
          value: Number((factSpend + estSpend).toFixed(4)),
          basis: estSpend > 0
            ? `fact: $${factSpend.toFixed(4)} via workflow_run_id join; +est $${estSpend.toFixed(4)} proportional share of unattributed`
            : `fact: $${factSpend.toFixed(4)} via workflow_run_id join`,
          confidence: estSpend > 0 ? 0.75 : 0.95,
        }
        : {
          factType: 'estimate' as const,
          value: Number(estSpend.toFixed(4)),
          basis: 'proportional-by-runs (no workflow_run_id on usage rows)',
          confidence: 0.3,
        },
      factType: 'fact' as const,
    }
  }).sort((a, b) => b.runs - a.runs)

  // Provider efficiency: cost per successful call
  const provRows = await db.select({
    provider: aiUsage.provider,
    spend:    sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
    calls:    sql<number>`count(*)::int`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, since)))
    .groupBy(aiUsage.provider).catch(() => [])

  const failByProv = await db.select({
    provider: providerFailures.providerId,
    n:        sql<number>`count(*)::int`,
  }).from(providerFailures)
    .where(and(eq(providerFailures.workspaceId, workspaceId), gte(providerFailures.createdAt, since)))
    .groupBy(providerFailures.providerId).catch(() => [])
  const failMap = new Map(failByProv.map(f => [f.provider, Number(f.n)]))

  const providersByEfficiency = provRows.map(p => {
    const calls = Number(p.calls)
    const spend = Number(p.spend)
    const successful = Math.max(0, calls - (failMap.get(p.provider) ?? 0))
    return {
      provider: p.provider,
      spendUsd: Number(spend.toFixed(4)),
      successfulCalls: successful,
      costPerSuccessUsd: {
        factType: 'estimate' as const,
        value: successful > 0 ? Number((spend / successful).toFixed(6)) : 0,
        basis: 'spend / (calls - logged-failures)',
        confidence: successful > 10 ? 0.7 : 0.4,
      },
    }
  }).filter(p => p.spendUsd > 0).sort((a, b) => a.costPerSuccessUsd.value - b.costPerSuccessUsd.value)

  // Past economic recommendation outcomes (the learning signal)
  const econChains = await db.select({
    matched: reasoningChains.outcomeMatched,
    known:   reasoningChains.outcomeKnown,
  }).from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, 'economic'),
      gte(reasoningChains.createdAt, since),
    )).catch(() => [])

  const econTotal   = econChains.length
  const econMatched = econChains.filter(c => c.known && c.matched === true).length
  const econUnmatched = econChains.filter(c => c.known && c.matched === false).length
  const econDecided = econMatched + econUnmatched

  return {
    windowDays,
    workflows,
    providersByEfficiency,
    recommendationOutcome: {
      economicChainsLogged: econTotal,
      matched: econMatched,
      unmatched: econUnmatched,
      matchRate: econDecided >= 5 ? Number((econMatched / econDecided).toFixed(3)) : null,
      factType: 'fact',
    },
    notes: [
      'Workflow run counts and statuses are facts; AI-spend attribution to workflows is an estimate (proportional-by-runs).',
      'costPerSuccessUsd = spend / (calls − logged-failures); only includes failures actually logged in provider_failures.',
      econDecided < 5
        ? `Recommendation outcome match-rate hidden: only ${econDecided} decided outcomes (need ≥5).`
        : `${econMatched}/${econDecided} past economic recommendations matched outcome.`,
    ],
  }
}

// ── 3. Resource Allocation Engine ─────────────────────────────────────────

export interface AllocationSuggestion {
  type: 'swap_provider' | 'reduce_concurrency' | 'increase_concurrency' | 'pause_research' | 'cache_more'
  factType: 'estimate'
  title: string
  rationale: string
  evidence: Array<{ source: string; extract: string }>
  estimatedSavingsUsd: number   // 0 if unknown
  confidence: number            // 0..1
}

export async function allocationSuggestions(workspaceId: string, windowDays = 7): Promise<AllocationSuggestion[]> {
  const s = await economicState(workspaceId, windowDays)
  const out: AllocationSuggestion[] = []

  // Suggestion A: provider swap if a clearly-cheaper-per-call provider exists for same task type
  const taskProviderRows = await db.select({
    taskType: aiUsage.taskType,
    provider: aiUsage.provider,
    spend:    sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
    calls:    sql<number>`count(*)::int`,
  }).from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, Date.now() - windowDays * 24 * 60 * 60_000)))
    .groupBy(aiUsage.taskType, aiUsage.provider).catch(() => [])

  const byTask = new Map<string, Array<{ provider: string; avg: number; calls: number; spend: number }>>()
  for (const r of taskProviderRows) {
    const calls = Number(r.calls), spend = Number(r.spend)
    if (calls < 5) continue   // ignore tiny samples
    const avg = spend / calls
    const arr = byTask.get(r.taskType) ?? []
    arr.push({ provider: r.provider, avg, calls, spend })
    byTask.set(r.taskType, arr)
  }
  for (const [taskType, options] of byTask) {
    if (options.length < 2) continue
    options.sort((a, b) => a.avg - b.avg)
    const cheapest = options[0]!
    const expensive = options[options.length - 1]!
    if (expensive.avg < cheapest.avg * 1.5) continue   // <50% diff: not worth swapping
    const savings = (expensive.avg - cheapest.avg) * expensive.calls
    if (savings < 0.10) continue
    out.push({
      type: 'swap_provider',
      factType: 'estimate',
      title: `Use ${cheapest.provider} for ${taskType} (${(expensive.avg / cheapest.avg).toFixed(1)}× cheaper than ${expensive.provider})`,
      rationale: `Avg cost/call: ${cheapest.provider}=$${cheapest.avg.toFixed(5)} vs ${expensive.provider}=$${expensive.avg.toFixed(5)} over ${expensive.calls} calls.`,
      evidence: [
        { source: 'ai_usage', extract: `task=${taskType}, ${cheapest.provider}/${cheapest.calls}calls vs ${expensive.provider}/${expensive.calls}calls (${windowDays}d)` },
      ],
      estimatedSavingsUsd: Number(savings.toFixed(2)),
      confidence: Math.min(0.8, 0.4 + Math.log10(expensive.calls + 1) * 0.1),
    })
  }

  // Suggestion B: pause research if budget burn is high
  if (s.budget && s.budget.dailyUtilization > 0.8) {
    out.push({
      type: 'pause_research',
      factType: 'estimate',
      title: 'Throttle research frequency — daily budget >80% utilized',
      rationale: `Daily spend $${s.budget.dailySpendUsd.toFixed(2)} of $${s.budget.dailyLimitUsd.toFixed(2)} limit (${(s.budget.dailyUtilization * 100).toFixed(0)}%).`,
      evidence: [{ source: 'provider_budgets', extract: `daily=${s.budget.dailySpendUsd}/${s.budget.dailyLimitUsd}` }],
      estimatedSavingsUsd: 0,   // can't honestly estimate
      confidence: 0.7,
    })
  }

  // Suggestion C: cache more if same provider has many same-task calls (proxy for cacheability)
  for (const t of s.byTaskType) {
    if (t.calls < 20 || t.spendUsd < 0.50) continue
    out.push({
      type: 'cache_more',
      factType: 'estimate',
      title: `Cache responses for ${t.taskType} (${t.calls} calls / $${t.spendUsd.toFixed(2)} in ${windowDays}d)`,
      rationale: `High volume task with avg $${t.avgCostUsd.toFixed(5)}/call. If 30% are repeat queries, caching saves ~$${(t.spendUsd * 0.3).toFixed(2)}.`,
      evidence: [{ source: 'ai_usage', extract: `task=${t.taskType}, calls=${t.calls}, spend=$${t.spendUsd}` }],
      estimatedSavingsUsd: Number((t.spendUsd * 0.3).toFixed(2)),
      confidence: 0.45,
    })
  }

  return out
}

// ── 4. Operational Efficiency Forecasting ─────────────────────────────────

interface LinFit { slope: number; intercept: number; r2: number; n: number }
function linearFit(values: number[]): LinFit {
  const n = values.length
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0, n }
  const xs = values.map((_, i) => i)
  const mx = xs.reduce((s, x) => s + x, 0) / n
  const my = values.reduce((s, y) => s + y, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i]!, y = values[i]!
    num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2
  }
  const slope = dx === 0 ? 0 : num / dx
  const r2 = dx === 0 || dy === 0 ? 0 : (num ** 2) / (dx * dy)
  return { slope, intercept: my - slope * mx, r2: Number(r2.toFixed(3)), n }
}

export interface EfficiencyForecast {
  windowDays: number
  dailySpendSeries: number[]   // raw observed, last N days
  factType: 'prediction'
  slopePerDayUsd: number
  projectedNextWeekUsd: number | null
  likelihood: 'low' | 'medium' | 'high' | 'insufficient_data'
  evidence: string
  confidence: number
}

type DailyQuery = (start: number, end: number) => Promise<number>

async function _forecastFromSeries(
  source: string, windowDays: number, query: DailyQuery,
): Promise<EfficiencyForecast & { source: string }> {
  const series: number[] = []
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayEnd   = Date.now() - i * 24 * 60 * 60_000
    const dayStart = dayEnd - 24 * 60 * 60_000
    series.push(Number((await query(dayStart, dayEnd)).toFixed(4)))
  }
  const nonZero = series.filter(v => v > 0).length
  const fit = linearFit(series)
  if (nonZero < 3 || fit.r2 < 0.3) {
    return {
      source, windowDays, dailySpendSeries: series, factType: 'prediction',
      slopePerDayUsd: Number(fit.slope.toFixed(4)),
      projectedNextWeekUsd: null, likelihood: 'insufficient_data',
      evidence: `${nonZero} non-zero days, r²=${fit.r2} (need ≥3 days and r²≥0.3)`,
      confidence: fit.r2,
    }
  }
  const projected = fit.intercept + fit.slope * (fit.n - 1 + 7)
  const projectedNextWeekUsd = Math.max(0, Number((projected * 7).toFixed(2)))
  const last = series[series.length - 1] ?? 0
  const ratio = last > 0 ? projected / last : 0
  const likelihood = ratio >= 2 ? 'high' : ratio >= 1.3 ? 'medium' : 'low'
  return {
    source, windowDays, dailySpendSeries: series, factType: 'prediction',
    slopePerDayUsd: Number(fit.slope.toFixed(4)),
    projectedNextWeekUsd,
    likelihood,
    evidence: `slope=$${fit.slope.toFixed(4)}/day, r²=${fit.r2}, projected $${projectedNextWeekUsd}/wk vs last day $${last.toFixed(2)}`,
    confidence: fit.r2,
  }
}

export async function efficiencyForecast(workspaceId: string, windowDays = 14): Promise<EfficiencyForecast> {
  const { source: _s, ...rest } = await _forecastFromSeries('ai_usage', windowDays, async (start, end) =>
    db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
      .from(aiUsage)
      .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, start), lt(aiUsage.timestamp, end)))
      .then(r => Number(r[0]?.s ?? 0)).catch(() => 0))
  return rest
}

/** Forecast per-source: ai_usage, image_generations, execution_leases */
export async function multiSourceForecast(workspaceId: string, windowDays = 14) {
  const [ai, ig, el] = await Promise.all([
    _forecastFromSeries('ai_usage', windowDays, async (start, end) =>
      db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
        .from(aiUsage)
        .where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, start), lt(aiUsage.timestamp, end)))
        .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)),
    _forecastFromSeries('image_generations', windowDays, async (start, end) =>
      db.select({ s: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float` })
        .from(imageGenerations)
        .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, start), lt(imageGenerations.createdAt, end)))
        .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)),
    _forecastFromSeries('execution_leases', windowDays, async (start, end) =>
      db.select({ s: sql<number>`coalesce(sum(${executionLeases.costUsd}), 0)::float` })
        .from(executionLeases)
        .where(and(eq(executionLeases.workspaceId, workspaceId), gte(executionLeases.createdAt, start), lt(executionLeases.createdAt, end)))
        .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)),
  ])
  return { ai, imageGen: ig, agentExec: el }
}

// ── 5. Strategic Economic Recommendations (writes to reasoning_chains) ───

export async function generateEconomicRecommendations(workspaceId: string): Promise<{
  suggestions: AllocationSuggestion[]
  forecast: EfficiencyForecast
  chainsRecorded: number
}> {
  const [suggestions, forecast] = await Promise.all([
    allocationSuggestions(workspaceId),
    efficiencyForecast(workspaceId),
  ])

  // Persist each suggestion + forecast as economic reasoning chain
  let chainsRecorded = 0
  for (const s of suggestions) {
    await recordChain({
      workspaceId,
      kind: 'economic',
      subjectId: s.type,
      decision: s.title,
      evidence: s.evidence.map(e => ({ type: e.source, id: s.type, extract: e.extract })),
      confidence: s.confidence,
      prediction: {
        kind: 'savings_estimate',
        estimatedSavingsUsd: s.estimatedSavingsUsd,
        type: s.type,
        recordedAt: Date.now(),
      },
      source: 'economic-intelligence',
    }).then(() => chainsRecorded++).catch(() => null)
  }
  if (forecast.likelihood !== 'insufficient_data' && forecast.projectedNextWeekUsd !== null) {
    await recordChain({
      workspaceId,
      kind: 'economic',
      subjectId: 'spend_forecast',
      decision: `Spend forecast: $${forecast.projectedNextWeekUsd}/wk (${forecast.likelihood})`,
      evidence: [{ type: 'ai_usage_daily', id: 'series', extract: forecast.evidence }],
      confidence: forecast.confidence,
      prediction: {
        kind: 'spend_forecast',
        projectedNextWeekUsd: forecast.projectedNextWeekUsd,
        slopePerDayUsd: forecast.slopePerDayUsd,
        recordedAt: Date.now(),
        horizonDays: 7,
      },
      source: 'economic-intelligence',
    }).then(() => chainsRecorded++).catch(() => null)

    // Push alert on high-likelihood spike (deduped by signature)
    if (forecast.likelihood === 'high') {
      await notify({
        workspaceId,
        type: 'economic.spend_spike_predicted',
        title: `Spend spike predicted: ~$${forecast.projectedNextWeekUsd}/wk`,
        body: `Linear extrapolation of last ${forecast.windowDays}d daily spend projects a HIGH-likelihood spike. ${forecast.evidence}`,
        severity: 'high',
        signature: `econ:spend_forecast:high:${Math.round(forecast.projectedNextWeekUsd / 5)}`,  // bucket by $5 to dedupe
      }).catch(() => null)
    }
  }
  return { suggestions, forecast, chainsRecorded }
}

// ── 6. War Room snapshot ──────────────────────────────────────────────────

export async function warRoomSnapshot(workspaceId: string) {
  const [state, roi, alloc, forecast, multi] = await Promise.all([
    economicState(workspaceId, 7),
    roiAnalysis(workspaceId, 30),
    allocationSuggestions(workspaceId, 7),
    efficiencyForecast(workspaceId, 14),
    multiSourceForecast(workspaceId, 14),
  ])
  // Waste alerts: high-spend providers with high failure rate
  const wasteAlerts = state.byProvider
    .filter(p => p.spendUsd > 0.50 && p.failureRate > 0.10)
    .map(p => ({
      provider: p.provider,
      spendUsd: p.spendUsd,
      failureRate: p.failureRate,
      wastedUsdEstimate: { factType: 'estimate' as const, value: Number((p.spendUsd * p.failureRate).toFixed(4)), basis: 'spend × failureRate', confidence: 0.5 },
    }))
  return {
    generatedAt: Date.now(),
    state, roi, allocationSuggestions: alloc, forecast, multiSourceForecast: multi, wasteAlerts,
  }
}

// ── 7. Economic Learning Loop ─────────────────────────────────────────────

/**
 * Evaluate past economic predictions against observed spend.
 * Called by a cron task (or on-demand).
 *
 * For `savings_estimate` chains: we cannot prove a counterfactual, so we
 * mark outcomeKnown=true ONLY if next-7d spend dropped after the chain
 * (correlation, not causation — recorded in evidence honestly).
 *
 * For `spend_forecast` chains: compare projected vs actual after horizon.
 */
export async function evaluateEconomicOutcomes(workspaceId: string): Promise<{
  evaluated: number
  matched: number
  unmatched: number
  notes: string[]
}> {
  const since = Date.now() - 60 * 24 * 60 * 60_000   // last 60 days
  const open = await db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, 'economic'),
      eq(reasoningChains.outcomeKnown, false),
      gte(reasoningChains.createdAt, since),
    )).catch(() => [])

  let matched = 0, unmatched = 0
  const notes: string[] = []

  for (const c of open) {
    const pred = c.prediction as { kind?: string; projectedNextWeekUsd?: number; recordedAt?: number; horizonDays?: number; estimatedSavingsUsd?: number } | null
    if (!pred) continue

    if (pred.kind === 'spend_forecast' && pred.recordedAt && pred.horizonDays && pred.projectedNextWeekUsd !== undefined) {
      const horizonEnd = pred.recordedAt + pred.horizonDays * 24 * 60 * 60_000
      if (Date.now() < horizonEnd) continue
      const start = pred.recordedAt
      const end   = horizonEnd
      const actual = await db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
        .from(aiUsage).where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, start), lt(aiUsage.timestamp, end)))
        .then(r => Number(r[0]?.s ?? 0)).catch(() => 0)
      // Match: actual within ±30% of projection
      const lo = pred.projectedNextWeekUsd * 0.7
      const hi = pred.projectedNextWeekUsd * 1.3
      const ok = actual >= lo && actual <= hi
      await db.update(reasoningChains).set({
        outcomeKnown: true, outcomeMatched: ok, outcomeAt: Date.now(),
        outcomeEvidence: { actualSpendUsd: Number(actual.toFixed(4)), projectedUsd: pred.projectedNextWeekUsd, withinBand: ok, band: '±30%' },
      }).where(eq(reasoningChains.id, c.id)).catch(() => null)
      if (ok) matched++; else unmatched++
    }

    if (pred.kind === 'savings_estimate' && pred.recordedAt && pred.estimatedSavingsUsd !== undefined) {
      const horizon = 7 * 24 * 60 * 60_000
      if (Date.now() < pred.recordedAt + horizon) continue
      // Compare 7d spend BEFORE vs 7d spend AFTER chain creation
      const beforeStart = pred.recordedAt - horizon, beforeEnd = pred.recordedAt
      const afterStart  = pred.recordedAt,           afterEnd  = pred.recordedAt + horizon
      const [before, after] = await Promise.all([
        db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
          .from(aiUsage).where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, beforeStart), lt(aiUsage.timestamp, beforeEnd)))
          .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
        db.select({ s: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
          .from(aiUsage).where(and(eq(aiUsage.workspaceId, workspaceId), gte(aiUsage.timestamp, afterStart), lt(aiUsage.timestamp, afterEnd)))
          .then(r => Number(r[0]?.s ?? 0)).catch(() => 0),
      ])
      const actualDelta = before - after  // positive = saved
      // Match: actual delta ≥ 50% of estimate. We DO NOT claim causation.
      const ok = pred.estimatedSavingsUsd > 0
        ? actualDelta >= pred.estimatedSavingsUsd * 0.5
        : actualDelta >= 0
      await db.update(reasoningChains).set({
        outcomeKnown: true, outcomeMatched: ok, outcomeAt: Date.now(),
        outcomeEvidence: {
          before7dUsd: Number(before.toFixed(4)),
          after7dUsd:  Number(after.toFixed(4)),
          deltaUsd:    Number(actualDelta.toFixed(4)),
          estimatedSavingsUsd: pred.estimatedSavingsUsd,
          note: 'correlation only — operator may have taken other actions',
        },
      }).where(eq(reasoningChains.id, c.id)).catch(() => null)
      if (ok) matched++; else unmatched++
    }
  }

  if (matched + unmatched > 0) {
    notes.push(`${matched}/${matched + unmatched} predictions matched (within tolerance band).`)
  } else {
    notes.push('No economic predictions reached horizon — try again later.')
  }
  return { evaluated: matched + unmatched, matched, unmatched, notes }
}

// ── True ROI (revenue − cost) ────────────────────────────────────────────

export async function trueRoi(workspaceId: string, windowDays = 30) {
  const [state, rev, revByWf] = await Promise.all([
    economicState(workspaceId, windowDays),
    revenueSummary(workspaceId, windowDays),
    revenueByWorkflow(workspaceId, windowDays),
  ])
  const totalCost = state.spend.total.value
  const netUsd    = Number((rev.totalUsd - totalCost).toFixed(2))
  return {
    windowDays,
    factType: 'fact' as const,
    revenueUsd: rev.totalUsd,
    costUsd:    totalCost,
    netUsd,
    roi: totalCost > 0 ? Number((netUsd / totalCost).toFixed(3)) : null,
    attributionRate: rev.attributionRate,
    perWorkflow: revByWf,
    notes: [
      rev.totalUsd === 0
        ? 'No revenue events in window — ingest via /economy/revenue or webhooks to enable real ROI.'
        : `Revenue ${rev.eventCount} events from sources: ${Object.keys(rev.bySource).join(', ')}.`,
      rev.attributionRate < 0.5 && rev.totalUsd > 0
        ? `Only ${(rev.attributionRate * 100).toFixed(0)}% of revenue is workflow-attributed — per-workflow ROI is partial.`
        : null,
    ].filter(Boolean),
  }
}

// Recent economic chains for UI
export async function recentEconomicChains(workspaceId: string, limit = 20) {
  return db.select().from(reasoningChains)
    .where(and(eq(reasoningChains.workspaceId, workspaceId), eq(reasoningChains.kind, 'economic')))
    .orderBy(desc(reasoningChains.createdAt))
    .limit(limit).catch(() => [])
}
