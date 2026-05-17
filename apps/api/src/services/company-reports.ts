/**
 * company-reports.ts — Company-wide intelligence reports.
 *
 * Three new specialized reports on top of existing executive-briefings:
 *   - engineeringHealthReport
 *   - operationalEfficiencyReport
 *   - growthOpportunityReport
 *
 * Pure read-side over real tables. Honest about sparse data.
 */
import { db }                          from '../db/client.js'
import {
  workflowRuns, events, incidents, auditFindings,
  researchFindings, telemetryEvents, agents,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { allTrends }                   from './trend-analysis.js'
import { divisionSnapshot }            from './divisions.js'

const DAY  = 24 * 60 * 60_000
const WEEK = 7 * DAY

// ─── Engineering Health ──────────────────────────────────────────────────────

export async function engineeringHealthReport(workspaceId: string) {
  const now = Date.now()
  const weekAgo = now - WEEK
  const [
    workflowsTotal, workflowsFailed, patchesApplied, rollbacks,
    codeAuditFindings, openIncidents, trendBlock, engDivision,
  ] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), gte(workflowRuns.triggeredAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, 'failed'), gte(workflowRuns.triggeredAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} in ('patch.applied','patch.auto_applied')`, gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(
        eq(auditFindings.workspaceId, workspaceId),
        sql`${auditFindings.category} in ('code_quality','reliability','optimization','runtime','testing')`,
      ))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    allTrends(workspaceId),
    divisionSnapshot(workspaceId, 'engineering'),
  ])

  const failureRate7d = workflowsTotal > 0 ? Number((workflowsFailed / workflowsTotal).toFixed(3)) : 0
  const rollbackRate7d = patchesApplied > 0 ? Number((rollbacks / patchesApplied).toFixed(3)) : 0

  return {
    workspaceId, composedAt: now, windowDays: 7,
    facts: {
      workflowsTotal, workflowsFailed, failureRate7d,
      patchesApplied, rollbacks, rollbackRate7d,
      openCodeAuditFindings: codeAuditFindings,
      openIncidents,
    },
    division: engDivision,
    trends: { reliability: trendBlock.reliability, productivity: trendBlock.productivity },
  }
}

// ─── Operational Efficiency ──────────────────────────────────────────────────

export async function operationalEfficiencyReport(workspaceId: string) {
  const now = Date.now()
  const weekAgo = now - WEEK

  const [
    incidentsTotal, incidentsResolved, incidentsCritical,
    governanceBlocks, autoThrottles, runningAgents, opsDivision,
  ] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.detectedAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'resolved'), gte(incidents.resolvedAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.severity, 'critical'), gte(incidents.detectedAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} like 'governance.%'`, gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'governance.auto_throttle_engaged'), gte(events.createdAt, weekAgo)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, 'running')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    divisionSnapshot(workspaceId, 'operations'),
  ])

  const resolutionRate = incidentsTotal > 0 ? Number((incidentsResolved / incidentsTotal).toFixed(3)) : null

  return {
    workspaceId, composedAt: now, windowDays: 7,
    facts: {
      incidentsTotal, incidentsResolved, incidentsCritical, resolutionRate,
      governanceBlocks, autoThrottles, runningAgents,
    },
    division: opsDivision,
  }
}

// ─── Growth Opportunity ──────────────────────────────────────────────────────

export async function growthOpportunityReport(workspaceId: string) {
  const now = Date.now()
  const weekAgo = now - WEEK

  const [
    highConfidenceFindings, growthKeywordFindings,
    featureUseCount, adoptionPathCount, growthDivision,
  ] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(researchFindings)
      .where(and(
        eq(researchFindings.workspaceId, workspaceId),
        gte(researchFindings.createdAt, weekAgo),
        sql`${researchFindings.factType} = 'fact' AND ${researchFindings.confidence} >= 0.7`,
      ))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({
      summary: researchFindings.summary,
      url: researchFindings.sourceUrl,
      confidence: researchFindings.confidence,
    }).from(researchFindings)
      .where(and(
        eq(researchFindings.workspaceId, workspaceId),
        gte(researchFindings.createdAt, 4 * WEEK + weekAgo - 5 * WEEK),  // last 5 weeks
        sql`(${researchFindings.summary} ilike '%competitor%' OR ${researchFindings.summary} ilike '%market%' OR ${researchFindings.summary} ilike '%adoption%' OR ${researchFindings.summary} ilike '%pricing%' OR ${researchFindings.summary} ilike '%growth%')`,
      ))
      .orderBy(desc(researchFindings.confidence))
      .limit(10).catch(() => []),

    db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents)
      .where(and(
        eq(telemetryEvents.workspaceId, workspaceId),
        eq(telemetryEvents.category, 'feature_use'),
        gte(telemetryEvents.createdAt, weekAgo),
      ))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({ c: sql<number>`count(distinct ${telemetryEvents.name})::int` }).from(telemetryEvents)
      .where(and(
        eq(telemetryEvents.workspaceId, workspaceId),
        gte(telemetryEvents.createdAt, weekAgo),
      ))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    divisionSnapshot(workspaceId, 'growth'),
  ])

  return {
    workspaceId, composedAt: now, windowDays: 7,
    facts: {
      highConfidenceResearchFindings: highConfidenceFindings,
      featureUseEvents7d:             featureUseCount,
      distinctFeaturesUsed7d:         adoptionPathCount,
      growthKeywordFindings: growthKeywordFindings.map(f => ({
        summary: String(f.summary ?? '').slice(0, 200),
        sourceUrl: String(f.url ?? ''),
        confidence: Number(f.confidence ?? 0),
      })),
    },
    division: growthDivision,
  }
}
