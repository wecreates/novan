/**
 * executive-briefings.ts — Specialized briefing assemblers.
 *
 *   - executiveDailyBriefing  (composite: facts + forecasts, clearly labelled)
 *   - weeklyOperationalReport (8-week + last-7-day comparison)
 *   - reliabilitySummary
 *   - securitySummary
 *   - costSummary
 *   - missionProgressReport
 *
 * Every payload separates `facts` from `predictions`. No fabrication.
 */
import { db }                          from '../db/client.js'
import {
  incidents, auditFindings, imageGenerations, providerBudgets,
  workflowRuns, strategicGoals, events, providerHealthLog,
} from '../db/schema.js'
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { generateDailyReview, type DailyReview } from './daily-review.js'
import { allTrends, type TrendSeries } from './trend-analysis.js'
import { generateForecasts, type Forecast } from './forecasting.js'
import { snapshot as continuitySnapshot } from './continuity-engine.js'
import { tradeoffsForTop, type Tradeoff } from './tradeoff-analysis.js'

const DAY  = 24 * 60 * 60_000
const WEEK = 7 * DAY

// ─── Executive Daily Briefing ────────────────────────────────────────────────

export interface ExecutiveDailyBriefing {
  workspaceId:  string
  composedAt:   number
  facts: {
    daily:       DailyReview
  }
  predictions: {
    forecasts:   Forecast[]
    note:        string
  }
  topTradeoffs:  Tradeoff[]
}

export async function executiveDailyBriefing(workspaceId: string): Promise<ExecutiveDailyBriefing> {
  const [daily, forecastsBlock, tradeoffs] = await Promise.all([
    generateDailyReview(workspaceId),
    generateForecasts(workspaceId),
    tradeoffsForTop(workspaceId, 5),
  ])
  return {
    workspaceId, composedAt: Date.now(),
    facts:       { daily },
    predictions: {
      forecasts: forecastsBlock.forecasts,
      note:      'Predictions are extrapolations from observed trends; treat as decision aids, not certainties.',
    },
    topTradeoffs: tradeoffs,
  }
}

// ─── Weekly Operational Report ───────────────────────────────────────────────

export interface WeeklyOperationalReport {
  workspaceId:  string
  composedAt:   number
  windowStart:  number
  windowEnd:    number
  facts: {
    week:        {
      incidents:        number
      criticalIncidents: number
      failedWorkflows:   number
      rollbacks:         number
      patchesApplied:    number
      deployments:       number
      missionCompletions: number
    }
    priorWeek:   WeeklyOperationalReport['facts']['week']
    deltas:      Record<string, number>
  }
  trends: {
    reliability:     TrendSeries
    incident:        TrendSeries
    deployment:      TrendSeries
    productivity:    TrendSeries
  }
  predictions: { forecasts: Forecast[] }
}

async function weeklyCounts(workspaceId: string, start: number, end: number) {
  const [inc, wf, ev, missions] = await Promise.all([
    db.select({
      total:  sql<number>`count(*)::int`,
      crit:   sql<number>`count(*) filter (where ${incidents.severity} = 'critical')::int`,
    }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.detectedAt, start), lt(incidents.detectedAt, end)))
      .then(r => r[0]).catch(() => ({ total: 0, crit: 0 })),
    db.select({
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
    }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, start), lt(workflowRuns.triggeredAt, end)))
      .then(r => r[0]).catch(() => ({ failed: 0 })),
    db.select({
      rollbacks: sql<number>`count(*) filter (where ${events.type} = 'patch.rolled_back')::int`,
      patches:   sql<number>`count(*) filter (where ${events.type} in ('patch.applied','patch.auto_applied'))::int`,
      deploys:   sql<number>`count(*) filter (where ${events.type} in ('deployment.started','deployment.completed'))::int`,
    }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, start), lt(events.createdAt, end)))
      .then(r => r[0]).catch(() => ({ rollbacks: 0, patches: 0, deploys: 0 })),
    db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
      .where(and(
        eq(strategicGoals.workspaceId, workspaceId),
        eq(strategicGoals.status, 'completed'),
        gte(strategicGoals.completedAt, start),
        lt(strategicGoals.completedAt,  end),
      ))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
  ])
  const incObj = inc ?? { total: 0, crit: 0 }
  const wfObj  = wf  ?? { failed: 0 }
  const evObj  = ev  ?? { rollbacks: 0, patches: 0, deploys: 0 }
  return {
    incidents:         Number(incObj.total),
    criticalIncidents: Number(incObj.crit),
    failedWorkflows:   Number(wfObj.failed),
    rollbacks:         Number(evObj.rollbacks),
    patchesApplied:    Number(evObj.patches),
    deployments:       Number(evObj.deploys),
    missionCompletions: missions,
  }
}

export async function weeklyOperationalReport(workspaceId: string): Promise<WeeklyOperationalReport> {
  const now = Date.now()
  const weekStart  = now - WEEK
  const priorStart = now - 2 * WEEK
  const [week, prior, trends, forecasts] = await Promise.all([
    weeklyCounts(workspaceId, weekStart, now),
    weeklyCounts(workspaceId, priorStart, weekStart),
    allTrends(workspaceId),
    generateForecasts(workspaceId),
  ])

  const deltas: Record<string, number> = {}
  for (const k of Object.keys(week) as Array<keyof typeof week>) {
    deltas[k] = (week[k] as number) - (prior[k] as number)
  }

  return {
    workspaceId, composedAt: now,
    windowStart: weekStart, windowEnd: now,
    facts: { week, priorWeek: prior, deltas },
    trends: {
      reliability:  trends.reliability,
      incident:     trends.incident,
      deployment:   trends.deployment,
      productivity: trends.productivity,
    },
    predictions: { forecasts: forecasts.forecasts },
  }
}

// ─── Specialized summaries ───────────────────────────────────────────────────

export async function reliabilitySummary(workspaceId: string) {
  const now = Date.now()
  const dayAgo = now - DAY
  const [openInc, openCrit, failed24h, rollback24h, trends, forecasts] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, 'failed'), gte(workflowRuns.failedAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, dayAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    allTrends(workspaceId),
    generateForecasts(workspaceId),
  ])
  const runtimeForecast = forecasts.forecasts.find(f => f.type === 'runtime_bottleneck_likely')
  const deployForecast  = forecasts.forecasts.find(f => f.type === 'deployment_instability_likely')
  return {
    workspaceId, composedAt: now,
    facts: {
      openIncidents:      openInc,
      openCriticalIncidents: openCrit,
      failedWorkflows24h: failed24h,
      rollbacks24h:       rollback24h,
      reliabilityTrend:   trends.reliability,
      deploymentTrend:    trends.deployment,
    },
    predictions: {
      runtimeBottleneck: runtimeForecast ?? null,
      deploymentInstability: deployForecast ?? null,
    },
  }
}

export async function securitySummary(workspaceId: string) {
  const now = Date.now()
  const weekAgo = now - WEEK
  const [secFindings, criticalSec, blockedFailures, blockedPatches, forecasts] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security'), eq(auditFindings.severity, 'critical')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} in ('governance.autonomous_action_blocked','governance.auto_throttle_engaged')`, gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.blocked_by_governance'), gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    generateForecasts(workspaceId),
  ])
  const securityForecast = forecasts.forecasts.find(f => f.type === 'security_risk_growing')
  return {
    workspaceId, composedAt: now,
    facts: {
      securityAuditFindings: secFindings,
      criticalSecurityFindings: criticalSec,
      governanceBlocks7d: blockedFailures,
      patchesBlocked7d:   blockedPatches,
    },
    predictions: {
      securityRiskGrowing: securityForecast ?? null,
    },
  }
}

export async function costSummary(workspaceId: string) {
  const now = Date.now()
  const dayAgo = now - DAY
  const [budget, imageSpend24h, imageSpend7d, costTrendBlock, forecasts] = await Promise.all([
    db.select().from(providerBudgets)
      .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1).then(r => r[0] ?? null).catch((e: Error) => { console.error('[executive-briefings]', e.message); return null }),
    db.select({
      spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      count: sql<number>`count(*)::int`,
    }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, dayAgo)))
      .then(r => r[0]).catch(() => ({ spend: 0, count: 0 })),
    db.select({
      spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}), 0)::float`,
      count: sql<number>`count(*)::int`,
    }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, now - WEEK)))
      .then(r => r[0]).catch(() => ({ spend: 0, count: 0 })),
    (await allTrends(workspaceId)).cost,
    generateForecasts(workspaceId),
  ])
  const budgetForecast = forecasts.forecasts.find(f => f.type === 'budget_overrun_likely')
  return {
    workspaceId, composedAt: now,
    facts: {
      dailyBudget: budget ? {
        limitUsd:  Number(budget.dailyLimitUsd),
        spentUsd:  Number(budget.dailySpendUsd),
        pctUsed:   budget.dailyLimitUsd > 0 ? Number((budget.dailySpendUsd / budget.dailyLimitUsd).toFixed(3)) : 0,
      } : null,
      monthlyBudget: budget ? {
        limitUsd:  Number(budget.monthlyLimitUsd),
        spentUsd:  Number(budget.monthlySpendUsd),
        pctUsed:   budget.monthlyLimitUsd > 0 ? Number((budget.monthlySpendUsd / budget.monthlyLimitUsd).toFixed(3)) : 0,
      } : null,
      imageSpend24h: { spendUsd: Number(Number(imageSpend24h?.spend ?? 0).toFixed(4)), count: Number(imageSpend24h?.count ?? 0) },
      imageSpend7d:  { spendUsd: Number(Number(imageSpend7d?.spend ?? 0).toFixed(4)), count: Number(imageSpend7d?.count ?? 0) },
      weeklyCostTrend: costTrendBlock,
    },
    predictions: {
      budgetOverrun: budgetForecast ?? null,
    },
  }
}

export async function missionProgressReport(workspaceId: string) {
  const now = Date.now()
  const continuity = await continuitySnapshot(workspaceId)
  const [active, completed, paused, atRiskList] = await Promise.all([
    db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
      .orderBy(strategicGoals.targetDate).catch(() => []),
    db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'completed')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'paused')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select().from(strategicGoals)
      .where(and(
        eq(strategicGoals.workspaceId, workspaceId),
        eq(strategicGoals.status, 'active'),
        sql`${strategicGoals.targetDate} is not null AND ${strategicGoals.targetDate} < ${now + 7 * DAY} AND ${strategicGoals.progress} < 0.7`,
      ))
      .orderBy(strategicGoals.targetDate).catch(() => []),
  ])

  return {
    workspaceId, composedAt: now,
    facts: {
      counts: {
        active:    active.length,
        completed,
        paused,
      },
      activeMissions: active.map(m => ({
        id: m.id, title: String(m.title ?? ''),
        horizon: String(m.horizon ?? ''),
        progress: Number(m.progress ?? 0),
        targetDate: m.targetDate as number | null,
      })),
      atRisk: atRiskList.map(m => ({
        id: m.id, title: String(m.title ?? ''),
        progress: Number(m.progress ?? 0),
        targetDate: m.targetDate as number | null,
        daysUntilTarget: m.targetDate ? Math.round(((m.targetDate as number) - now) / DAY) : null,
      })),
      unresolvedRisks: continuity.unresolvedRisks,
      recurringBottlenecks: continuity.recurringBottlenecks,
    },
  }
}
