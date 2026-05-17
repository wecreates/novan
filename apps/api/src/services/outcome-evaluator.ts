/**
 * outcome-evaluator.ts — Multi-source outcome linking for reasoning chains.
 *
 * Three sources beyond recommendation.acted_on (which is already wired):
 *
 *   1. Incident resolutions — when an incident closes, link to the rec
 *      chain that recommended fixing that incident.
 *   2. Forecast horizon passage — when a forecast's horizon window
 *      passes, compare projectedValue vs observed value and mark
 *      outcomeMatched.
 *   3. Patch success/failure — when patch.rolled_back fires, mark
 *      related recommendations' outcomeMatched=false.
 */
import { db }                          from '../db/client.js'
import { reasoningChains, incidents, events, imageGenerations, workflowRuns, providerHealthLog } from '../db/schema.js'
import { and, eq, gte, sql }           from 'drizzle-orm'
import { linkOutcome }                 from './reasoning-chains.js'
import { allTrends }                   from './trend-analysis.js'

const WEEK = 7 * 24 * 60 * 60_000

export interface OutcomeReport {
  workspaceId:               string
  incidentLinks:             number
  forecastHorizonsEvaluated: number
  forecastsMatched:          number
  forecastsMissed:           number
  rollbacksLinked:           number
}

// ─── 1. Incident resolution → reasoning chain ────────────────────────────────

async function linkIncidentResolutions(workspaceId: string): Promise<number> {
  // Find incidents resolved in the last 7d that have no chain link
  const since = Date.now() - WEEK
  const resolved = await db.select().from(incidents)
    .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'resolved'), gte(incidents.resolvedAt, since)))
    .catch(() => [])

  let linked = 0
  for (const inc of resolved) {
    // Match recommendation chains where evidence references this incident
    const chains = await db.select().from(reasoningChains)
      .where(and(
        eq(reasoningChains.workspaceId, workspaceId),
        eq(reasoningChains.kind, 'recommendation'),
        eq(reasoningChains.subjectId, `incident:${inc.id}`),
        eq(reasoningChains.outcomeKnown, false),
      ))
      .limit(1).then(r => r[0]).catch(() => null)
    if (!chains) continue
    await linkOutcome(workspaceId, chains.id, true, {
      source: 'incident.resolved',
      incidentId: inc.id,
      resolutionNote: inc.resolutionNote ?? null,
      resolvedAt: inc.resolvedAt,
    })
    linked++
  }
  return linked
}

// ─── 2. Forecast horizon passage → match projection vs observed ──────────────

async function evaluateForecastHorizons(workspaceId: string): Promise<{ evaluated: number; matched: number; missed: number }> {
  // Find forecast chains whose horizon has passed (createdAt + horizonWeeks*7d < now)
  // and that don't yet have an outcome
  const unknownForecasts = await db.select().from(reasoningChains)
    .where(and(
      eq(reasoningChains.workspaceId, workspaceId),
      eq(reasoningChains.kind, 'forecast'),
      eq(reasoningChains.outcomeKnown, false),
    ))
    .catch(() => [])

  const now = Date.now()
  let evaluated = 0, matched = 0, missed = 0

  // Pull current trend data once
  const trends = await allTrends(workspaceId).catch(() => null)
  if (!trends) return { evaluated, matched, missed }

  for (const c of unknownForecasts) {
    const pred = (c.prediction ?? {}) as Record<string, unknown>
    const horizonWeeks = Number(pred['horizonWeeks'] ?? 0)
    const projectedValue = pred['projectedValue']
    if (!horizonWeeks || projectedValue === null || projectedValue === undefined) continue

    // Has the horizon passed?
    const horizonEnd = Number(c.createdAt) + horizonWeeks * WEEK
    if (horizonEnd > now) continue   // still in the future

    // Map subject (forecast type) to the trend metric we need
    let observed: number | null = null
    const subject = c.subjectId ?? ''
    if (subject === 'provider_failure_likely') {
      // Use most recent latency average
      const latencies = trends.providerQuality.series.map(b => Number(b.metrics['avgLatencyMs'] ?? 0)).filter(n => n > 0)
      observed = latencies.length > 0 ? latencies[latencies.length - 1]! : null
    } else if (subject === 'budget_overrun_likely') {
      const spends = trends.cost.series.map(b => Number(b.metrics['spendUsd'] ?? 0))
      observed = spends[spends.length - 1] ?? 0
    } else if (subject === 'runtime_bottleneck_likely') {
      const rates = trends.reliability.series.map(b => Number(b.metrics['failureRate'] ?? 0))
      observed = rates[rates.length - 1] ?? 0
    } else if (subject === 'deployment_instability_likely') {
      const fails = trends.deployment.series.map(b => Number(b.metrics['failed'] ?? 0))
      observed = fails[fails.length - 1] ?? 0
    } else if (subject === 'security_risk_growing' || subject === 'scaling_pressure_growing') {
      const key = subject === 'security_risk_growing' ? 'critical' : 'count'
      const vals = trends.incident.series.map(b => Number(b.metrics[key] ?? 0))
      observed = vals[vals.length - 1] ?? 0
    }

    if (observed === null) continue
    // Match: predicted direction matched observed direction within 30% tolerance
    const projected = Number(projectedValue)
    const tolerance = Math.max(Math.abs(projected) * 0.3, 0.5)
    const isMatch = Math.abs(observed - projected) <= tolerance

    await linkOutcome(workspaceId, c.id, isMatch, {
      source:   'forecast_horizon_passed',
      projected: projected,
      observed,
      tolerance,
      horizonEnd,
    })
    evaluated++
    if (isMatch) matched++; else missed++
  }
  return { evaluated, matched, missed }
}

// ─── 3. Rollback → mark related rec chains as outcome=false ──────────────────

async function linkRollbacksToRecommendations(workspaceId: string): Promise<number> {
  // Heuristic: if a rec was 'accepted' and a rollback happened within
  // 24h on a related file, downgrade the outcome.
  // Conservative: only flips chains that are accepted-but-rolled-back.
  const since = Date.now() - 7 * WEEK
  const rollbacks = await db.select().from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, since)))
    .catch(() => [])

  let linked = 0
  for (const rb of rollbacks) {
    const p = (rb.payload ?? {}) as Record<string, unknown>
    const filePath = typeof p['filePath'] === 'string' ? p['filePath'] as string : null
    if (!filePath) continue
    // Find recommendation chains accepted within 24h before this rollback
    const window24h = Number(rb.createdAt) - 24 * 60 * 60_000
    const candidates = await db.select().from(reasoningChains)
      .where(and(
        eq(reasoningChains.workspaceId, workspaceId),
        eq(reasoningChains.kind, 'recommendation'),
        eq(reasoningChains.outcomeMatched, true),
        gte(reasoningChains.createdAt, window24h),
      ))
      .catch(() => [])
    // Best-effort: if file path appears anywhere in evidence, downgrade
    for (const c of candidates) {
      const evi = JSON.stringify(c.evidence ?? [])
      if (evi.includes(filePath)) {
        await db.update(reasoningChains).set({
          outcomeMatched: false,
          outcomeEvidence: { downgradedBy: 'rollback', filePath, rollbackEventId: rb.id, reason: p['reason'] ?? null } as never,
          outcomeAt: Date.now(),
        }).where(eq(reasoningChains.id, c.id)).catch(() => null)
        linked++
      }
    }
  }
  return linked
}

// ─── Public orchestrator ─────────────────────────────────────────────────────

export async function evaluateOutcomes(workspaceId: string): Promise<OutcomeReport> {
  const [incidentLinks, fc, rb] = await Promise.all([
    linkIncidentResolutions(workspaceId).catch(() => 0),
    evaluateForecastHorizons(workspaceId).catch(() => ({ evaluated: 0, matched: 0, missed: 0 })),
    linkRollbacksToRecommendations(workspaceId).catch(() => 0),
  ])
  return {
    workspaceId,
    incidentLinks,
    forecastHorizonsEvaluated: fc.evaluated,
    forecastsMatched: fc.matched,
    forecastsMissed: fc.missed,
    rollbacksLinked: rb,
  }
}
