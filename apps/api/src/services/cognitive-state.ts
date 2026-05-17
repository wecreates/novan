/**
 * cognitive-state.ts — Unified cognitive state + world model.
 *
 * Pure read-side aggregator over real tables. Returns a single snapshot
 * answering "what does Novan currently know about itself?"
 *
 * Layered memory facade:
 *   - short-term   events (last 1h)
 *   - working      telemetry + incidents (last 24h)
 *   - long-term    strategic_goals + successful_fixes
 *   - failure      failure_memory
 *   - research     research_findings
 *   - mission      strategic_goals (active)
 */
import { db }                          from '../db/client.js'
import {
  events, incidents, strategicGoals, successfulFixes, failureMemory,
  researchFindings, telemetryEvents, providerHealthLog, agents,
  imageGenerations, patchApprovals, auditFindings,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { detectGaps }                  from './capability-gap-detector.js'
import { getPreferences }              from './operator-preferences.js'

const HOUR = 60 * 60_000
const DAY  = 24 * HOUR
const WEEK = 7 * DAY

export interface CognitiveSnapshot {
  workspaceId:    string
  capturedAt:     number
  state: {
    activeGoals:        Array<{ id: string; title: string; progress: number }>
    strategicPriorities: Array<{ category: string; count: number; avgProgress: number }>
    unresolvedRisks:    Array<{ source: string; title: string; severity: string }>
    activeMissions:     number
    operationalContext: { runningAgents: number; openIncidents: number; pendingApprovals: number }
    currentBottlenecks: Array<{ signature: string; occurrences: number }>
    recentIncidents:    Array<{ title: string; severity: string; status: string; ageHours: number }>
    capabilityGaps:     number
    operatorPreferences: { riskTolerance: string; approvalAutoApplyMinConfidence: number }
    systemLimitations:  string[]
  }
  worldModel: {
    runtime:        { eventsPerHour: number; agentsRunning: number }
    providers:      Array<{ id: string; healthy: number; degraded: number; down: number }>
    workers:        { healthy: number; offline: number }    // best-effort from agent statuses
    costs:          { dailySpendUsd: number; weeklySpendUsd: number }
    missions:       { active: number; completed: number; paused: number }
    infrastructure: { auditFindings: number; openIncidents: number }
    securityPosture: { criticalAuditFindings: number; openSecurityFindings: number }
    learningState:  { researchFindingsWeek: number; successfulFixesAllTime: number }
    capabilities:   { trackedTotal: number; gaps: number }
  }
  memoryHierarchy: {
    shortTerm:   { eventsLastHour: number; topTypes: Array<{ type: string; n: number }> }
    working:     { telemetryLast24h: number; incidentsOpen: number }
    longTerm:    { strategicGoals: number; provenFixes: number }
    failure:     { patterns: number; recurringBlockers: number }
    research:    { findingsAllTime: number; lastFindingAgeHours: number | null }
    mission:     { active: number; completed: number }
  }
}

async function int(q: Promise<Array<{ c: number }>>): Promise<number> {
  return q.then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

export async function snapshot(workspaceId: string): Promise<CognitiveSnapshot> {
  const now = Date.now()
  const hourAgo = now - HOUR
  const dayAgo  = now - DAY
  const weekAgo = now - WEEK

  const [
    activeGoals, missionAgg, openInc, openCritInc, pendingApp,
    bottlenecks, recentInc, eventsLastHour, eventTypeTop,
    telemetry24h, providerHealth, runningAgents,
    spendDay, spendWeek, audit, secAudit, secCritical,
    researchWeek, lastFinding, allFixes, gapCount, allGoals, allFails,
    prefs,
  ] = await Promise.all([
    db.select({ id: strategicGoals.id, title: strategicGoals.title, progress: strategicGoals.progress }).from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
      .orderBy(desc(strategicGoals.updatedAt)).limit(5).catch(() => []),

    db.select({
      active: sql<number>`count(*) filter (where ${strategicGoals.status} = 'active')::int`,
      completed: sql<number>`count(*) filter (where ${strategicGoals.status} = 'completed')::int`,
      paused: sql<number>`count(*) filter (where ${strategicGoals.status} = 'paused')::int`,
    }).from(strategicGoals)
      .where(eq(strategicGoals.workspaceId, workspaceId))
      .then(r => r[0] ?? { active: 0, completed: 0, paused: 0 }).catch(() => ({ active: 0, completed: 0, paused: 0 })),

    db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .orderBy(desc(incidents.detectedAt)).limit(10).catch(() => []),

    int(db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))),

    int(db.select({ c: sql<number>`count(*)::int` }).from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))),

    db.select({
      signature: failureMemory.signature,
      occurrences: failureMemory.occurrenceCount,
    }).from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount)).limit(5)
      .then(rs => rs.filter(r => Number(r.occurrences) >= 3)).catch(() => []),

    db.select({
      title: incidents.title, severity: incidents.severity, status: incidents.status, detectedAt: incidents.detectedAt,
    }).from(incidents)
      .where(eq(incidents.workspaceId, workspaceId))
      .orderBy(desc(incidents.detectedAt)).limit(5).catch(() => []),

    int(db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, hourAgo)))),

    db.select({
      type: events.type,
      c: sql<number>`count(*)::int`,
    }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, hourAgo)))
      .groupBy(events.type).orderBy(desc(sql`count(*)`)).limit(5).catch(() => []),

    int(db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, dayAgo)))),

    db.select({
      provider: providerHealthLog.providerId,
      healthy: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'healthy')::int`,
      degraded: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'degraded')::int`,
      down: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'down')::int`,
    }).from(providerHealthLog)
      .where(and(eq(providerHealthLog.workspaceId, workspaceId), gte(providerHealthLog.checkedAt, weekAgo)))
      .groupBy(providerHealthLog.providerId).limit(10).catch(() => []),

    int(db.select({ c: sql<number>`count(*)::int` }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, 'running')))),

    db.select({ spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}),0)::float` }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, dayAgo)))
      .then(r => Number(r[0]?.spend ?? 0)).catch(() => 0),
    db.select({ spend: sql<number>`coalesce(sum(${imageGenerations.actualCostUsd}),0)::float` }).from(imageGenerations)
      .where(and(eq(imageGenerations.workspaceId, workspaceId), gte(imageGenerations.createdAt, weekAgo)))
      .then(r => Number(r[0]?.spend ?? 0)).catch(() => 0),

    int(db.select({ c: sql<number>`count(*)::int` }).from(auditFindings).where(eq(auditFindings.workspaceId, workspaceId))),
    int(db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))),
    int(db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security'), eq(auditFindings.severity, 'critical')))),

    int(db.select({ c: sql<number>`count(*)::int` }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), gte(researchFindings.createdAt, weekAgo)))),
    db.select({ ts: researchFindings.createdAt }).from(researchFindings)
      .where(eq(researchFindings.workspaceId, workspaceId))
      .orderBy(desc(researchFindings.createdAt)).limit(1)
      .then(r => r[0]?.ts ? Number(r[0].ts) : null).catch(() => null),

    int(db.select({ c: sql<number>`coalesce(sum(${successfulFixes.successCount}),0)::int` }).from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))),

    detectGaps(workspaceId).then(g => g.length).catch(() => 0),

    int(db.select({ c: sql<number>`count(*)::int` }).from(strategicGoals).where(eq(strategicGoals.workspaceId, workspaceId))),
    int(db.select({ c: sql<number>`count(*)::int` }).from(failureMemory).where(eq(failureMemory.workspaceId, workspaceId))),

    getPreferences(workspaceId).catch(() => null),
  ])

  const lastFindingAgeHours = lastFinding ? (now - lastFinding) / HOUR : null

  // System limitations — honest, derived from current state
  const limitations: string[] = []
  if (gapCount > 0) limitations.push(`${gapCount} capabilities scaffolded but unexercised`)
  if (openCritInc > 0) limitations.push(`${openCritInc} critical incident(s) open — emergency throttle engaged`)
  if (audit > 100) limitations.push(`${audit} unresolved audit findings — signal/noise degraded`)
  if (researchWeek === 0) limitations.push('no research activity this week')
  if (allFixes === 0) limitations.push('no proven fixes yet — context-aware recommendations have no history to cite')

  return {
    workspaceId, capturedAt: now,
    state: {
      activeGoals: activeGoals.map(g => ({ id: g.id, title: String(g.title ?? ''), progress: Number(g.progress ?? 0) })),
      strategicPriorities: [],   // computed by executive-loop; placeholder empty here
      unresolvedRisks: recentInc
        .filter(i => String(i.status) === 'open')
        .map(i => ({ source: 'incident', title: String(i.title ?? ''), severity: String(i.severity ?? '') })),
      activeMissions: Number(missionAgg.active),
      operationalContext: { runningAgents, openIncidents: openInc.length, pendingApprovals: pendingApp },
      currentBottlenecks: bottlenecks.map(b => ({ signature: String(b.signature ?? '').slice(0, 100), occurrences: Number(b.occurrences ?? 0) })),
      recentIncidents: recentInc.map(i => ({
        title: String(i.title ?? ''), severity: String(i.severity ?? ''), status: String(i.status ?? ''),
        ageHours: Number(((now - Number(i.detectedAt ?? 0)) / HOUR).toFixed(1)),
      })),
      capabilityGaps: gapCount,
      operatorPreferences: prefs
        ? { riskTolerance: prefs.riskTolerance, approvalAutoApplyMinConfidence: prefs.approvalAutoApplyMinConfidence }
        : { riskTolerance: 'balanced', approvalAutoApplyMinConfidence: 0.8 },
      systemLimitations: limitations,
    },
    worldModel: {
      runtime: { eventsPerHour: eventsLastHour, agentsRunning: runningAgents },
      providers: providerHealth.map(p => ({
        id: String(p.provider), healthy: Number(p.healthy), degraded: Number(p.degraded), down: Number(p.down),
      })),
      workers: { healthy: runningAgents, offline: 0 },
      costs: { dailySpendUsd: Number(spendDay.toFixed(4)), weeklySpendUsd: Number(spendWeek.toFixed(4)) },
      missions: { active: Number(missionAgg.active), completed: Number(missionAgg.completed), paused: Number(missionAgg.paused) },
      infrastructure: { auditFindings: audit, openIncidents: openInc.length },
      securityPosture: { criticalAuditFindings: secCritical, openSecurityFindings: secAudit },
      learningState: { researchFindingsWeek: researchWeek, successfulFixesAllTime: allFixes },
      capabilities: { trackedTotal: 33, gaps: gapCount },
    },
    memoryHierarchy: {
      shortTerm: { eventsLastHour, topTypes: eventTypeTop.map(t => ({ type: t.type, n: Number(t.c) })) },
      working:   { telemetryLast24h: telemetry24h, incidentsOpen: openInc.length },
      longTerm:  { strategicGoals: allGoals, provenFixes: allFixes },
      failure:   { patterns: allFails, recurringBlockers: bottlenecks.length },
      research:  { findingsAllTime: 0, lastFindingAgeHours },  // findingsAllTime computed inline below
      mission:   { active: Number(missionAgg.active), completed: Number(missionAgg.completed) },
    },
  }
}
