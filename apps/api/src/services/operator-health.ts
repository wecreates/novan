/**
 * operator-health.ts — Operator success engine.
 *
 * Pure read-side: pulls real signals from events, telemetry, feedback,
 * incidents, audit findings, image generations, research findings, and
 * computes a workspace health score + friction list + recommendations.
 *
 * No fake metrics. Every component score is traceable to a count.
 */
import { db }                          from '../db/client.js'
import {
  events, telemetryEvents, feedbackReports, incidents, auditFindings,
  imageGenerations, researchFindings, researchTopics, agents, workspaces,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'

export interface OperatorHealth {
  workspaceId:        string
  score:              number              // 0..1 (higher = healthier)
  band:               'critical' | 'struggling' | 'healthy' | 'thriving'
  signals: {
    onboardingComplete:    boolean
    onboardingCompletion:  number          // 0..1
    activeAgents:          number
    workflowsRun24h:       number
    completions24h:        number
    failures24h:           number
    failureRate24h:        number
    openIncidents:         number
    auditFindings:         number
    feedbackOpen:          number
    rollbacks24h:          number
    approvalsBlocked24h:   number
  }
  topFriction:        Array<{ name: string; failures: number }>
  recommendations:    string[]
}

const DAY = 24 * 60 * 60_000

async function count<T>(q: Promise<Array<{ c: T }>>): Promise<number> {
  return q.then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
}

async function onboardingProgress(workspaceId: string) {
  // 5 checkpoints — each contributes 20%
  const [hasWorkspace, hasAgents, hasResearchTopic, hasTelemetry, hasFeedbackPath] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(workspaces).where(eq(workspaces.id, workspaceId)).then(r => Number(r[0]?.c ?? 0)),
    db.select({ c: sql<number>`count(*)::int` }).from(agents).where(eq(agents.workspaceId, workspaceId)).then(r => Number(r[0]?.c ?? 0)),
    db.select({ c: sql<number>`count(*)::int` }).from(researchTopics).where(eq(researchTopics.workspaceId, workspaceId)).then(r => Number(r[0]?.c ?? 0)),
    db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents).where(eq(telemetryEvents.workspaceId, workspaceId)).then(r => Number(r[0]?.c ?? 0)),
    db.select({ c: sql<number>`count(*)::int` }).from(feedbackReports).where(eq(feedbackReports.workspaceId, workspaceId)).then(r => Number(r[0]?.c ?? 0)),
  ])
  const checkpoints = [hasWorkspace > 0, hasAgents > 0, hasResearchTopic > 0, hasTelemetry > 0, hasFeedbackPath > 0]
  const completed = checkpoints.filter(Boolean).length
  return { completion: completed / checkpoints.length, complete: completed >= 4, checkpoints }
}

export async function computeHealth(workspaceId: string): Promise<OperatorHealth> {
  const since = Date.now() - DAY

  const [
    onboarding, activeAgents, completions24h, failures24h,
    openInc, audit, openFb, rollbacks24h, blocked24h,
    topFriction,
  ] = await Promise.all([
    onboardingProgress(workspaceId),
    count(db.select({ c: sql<number>`count(*)::int` }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.status, 'running')))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), eq(telemetryEvents.category, 'completion'), gte(telemetryEvents.createdAt, since)))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), eq(telemetryEvents.outcome, 'failure'), gte(telemetryEvents.createdAt, since)))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(eq(auditFindings.workspaceId, workspaceId))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(feedbackReports)
      .where(and(eq(feedbackReports.workspaceId, workspaceId), eq(feedbackReports.status, 'open')))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, since)))),
    count(db.select({ c: sql<number>`count(*)::int` }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), eq(telemetryEvents.outcome, 'blocked'), gte(telemetryEvents.createdAt, since)))),
    db.select({
      name:     telemetryEvents.name,
      failures: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'failure')::int`,
    }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, since)))
      .groupBy(telemetryEvents.name)
      .having(sql`count(*) filter (where ${telemetryEvents.outcome} = 'failure') >= 2`)
      .orderBy(desc(sql`count(*) filter (where ${telemetryEvents.outcome} = 'failure')`))
      .limit(5)
      .then(rs => rs.map(r => ({ name: r.name, failures: Number(r.failures) }))).catch(() => []),
  ])

  const totalAct = completions24h + failures24h
  const failureRate24h = totalAct === 0 ? 0 : failures24h / totalAct

  // Score components (each 0..1; weighted)
  const c1 = onboarding.completion                          // 25%
  const c2 = 1 - Math.min(1, failureRate24h)                // 25%
  const c3 = openInc === 0 ? 1 : Math.max(0, 1 - openInc / 3)   // 15%
  const c4 = openFb  === 0 ? 1 : Math.max(0, 1 - openFb / 10)   // 10%
  const c5 = audit < 50 ? 1 : audit < 200 ? 0.6 : audit < 400 ? 0.3 : 0.1   // 15%
  const c6 = rollbacks24h === 0 ? 1 : Math.max(0, 1 - rollbacks24h / 5)     // 10%
  const score =
      c1 * 0.25 + c2 * 0.25 + c3 * 0.15 + c4 * 0.10 + c5 * 0.15 + c6 * 0.10

  const band: OperatorHealth['band'] =
      score >= 0.85 ? 'thriving'
    : score >= 0.65 ? 'healthy'
    : score >= 0.40 ? 'struggling'
    :                 'critical'

  const recommendations: string[] = []
  if (!onboarding.complete) recommendations.push(`onboarding: ${(onboarding.completion * 100).toFixed(0)}% complete — finish remaining checkpoints`)
  if (openInc > 0)            recommendations.push(`resolve ${openInc} open incident(s) before new autonomous actions`)
  if (audit >= 200)           recommendations.push(`triage ${audit} audit findings — high noise blocks priority signal`)
  if (failureRate24h >= 0.3)  recommendations.push(`24h failure rate ${(failureRate24h*100).toFixed(0)}% — check most-failing flow: ${topFriction[0]?.name ?? 'n/a'}`)
  if (rollbacks24h >= 3)      recommendations.push(`${rollbacks24h} rollbacks in 24h — review patch confidence thresholds`)
  if (openFb >= 5)            recommendations.push(`${openFb} open feedback reports — acknowledge or resolve top-severity`)
  if (recommendations.length === 0) recommendations.push('operator healthy — no immediate friction detected')

  return {
    workspaceId, score: Number(score.toFixed(3)), band,
    signals: {
      onboardingComplete:    onboarding.complete,
      onboardingCompletion:  Number(onboarding.completion.toFixed(2)),
      activeAgents,
      workflowsRun24h:       totalAct,
      completions24h, failures24h, failureRate24h: Number(failureRate24h.toFixed(3)),
      openIncidents:         openInc,
      auditFindings:         audit,
      feedbackOpen:          openFb,
      rollbacks24h,
      approvalsBlocked24h:   blocked24h,
    },
    topFriction,
    recommendations,
  }
}

export interface RetentionSignals {
  daysActive7d:       number    // distinct days with any activity in last 7d
  daysActive30d:      number
  autonomousAdoption: number    // 0..1 — fraction of days where autonomous features used
  researchAdoption:   number
  imageAdoption:      number
  warRoomEngagement:  number    // platform endpoint hits
}

export async function retentionSignals(workspaceId: string): Promise<RetentionSignals> {
  const day = 24 * 60 * 60_000
  const w7 = Date.now() - 7  * day
  const w30 = Date.now() - 30 * day

  const distinctDays = async (since: number): Promise<number> => {
    const r = await db.select({
      c: sql<number>`count(distinct date_trunc('day', to_timestamp(${telemetryEvents.createdAt} / 1000)))::int`,
    }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, since)))
      .catch(() => [{ c: 0 }])
    return Number(r[0]?.c ?? 0)
  }

  const adoption = async (prefix: string, since: number): Promise<number> => {
    const r = await db.select({ c: sql<number>`count(distinct date_trunc('day', to_timestamp(${telemetryEvents.createdAt} / 1000)))::int` })
      .from(telemetryEvents)
      .where(and(
        eq(telemetryEvents.workspaceId, workspaceId),
        sql`${telemetryEvents.name} like ${prefix + '%'}`,
        gte(telemetryEvents.createdAt, since),
      )).catch(() => [{ c: 0 }])
    const days = Number(r[0]?.c ?? 0)
    return days / 7
  }

  const warRoom = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} like 'platform.%'`, gte(events.createdAt, w7)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)

  const [d7, d30, autoA, resA, imgA] = await Promise.all([
    distinctDays(w7), distinctDays(w30),
    adoption('autonomous.', w7), adoption('research.', w7), adoption('image.', w7),
  ])

  return {
    daysActive7d:       d7,
    daysActive30d:      d30,
    autonomousAdoption: Number(autoA.toFixed(2)),
    researchAdoption:   Number(resA.toFixed(2)),
    imageAdoption:      Number(imgA.toFixed(2)),
    warRoomEngagement:  warRoom,
  }
}
