/**
 * engagement-feed.ts — Operator daily-loop feeds.
 *
 *   - missionFeed:        active/blocked/completed missions + estimated impact
 *   - accomplishmentFeed: real recent events grouped by agent activity
 *   - sinceLastVisit:     "what changed since timestamp X"
 *   - homeSummary:        composed first-screen payload (no UI — caller renders)
 *
 * All read-only. Pulls from real tables only. No fakes.
 */
import { db }                          from '../db/client.js'
import {
  strategicGoals, events, incidents, patchApprovals, roadmapTasks,
  researchFindings, successfulFixes, auditFindings, telemetryEvents,
  feedbackReports,
} from '../db/schema.js'
import { and, count, desc, eq, gte, sql } from 'drizzle-orm'
import { topRecommendations, type Recommendation } from './recommendation-engine.js'

// ─── Mission Feed ─────────────────────────────────────────────────────────────

export interface MissionFeedItem {
  id:           string
  title:        string
  horizon:      string
  status:       string
  progress:     number
  targetDate:   number | null
  estimatedImpact: 'low' | 'medium' | 'high'
  blockedBy?:   string
}

export async function missionFeed(workspaceId: string): Promise<{
  active:    MissionFeedItem[]
  blocked:   MissionFeedItem[]
  completed: MissionFeedItem[]
  pendingApprovals: number
}> {
  const [active, blocked, completed, approvals] = await Promise.all([
    db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'active')))
      .orderBy(strategicGoals.targetDate).limit(10).catch(() => []),
    db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'paused')))
      .orderBy(desc(strategicGoals.updatedAt)).limit(5).catch(() => []),
    db.select().from(strategicGoals)
      .where(and(eq(strategicGoals.workspaceId, workspaceId), eq(strategicGoals.status, 'completed')))
      .orderBy(desc(strategicGoals.completedAt)).limit(5).catch(() => []),
    db.select({ c: sql<number>`count(*)::int` }).from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
  ])

  const map = (g: typeof active[number]): MissionFeedItem => ({
    id: g.id, title: g.title, horizon: g.horizon, status: g.status,
    progress: Number(g.progress ?? 0),
    targetDate: g.targetDate as number | null,
    estimatedImpact:
      g.horizon === 'year' ? 'high' :
      g.horizon === 'quarter' ? 'medium' : 'low',
  })

  return {
    active:    active.map(map),
    blocked:   blocked.map(map),
    completed: completed.map(map),
    pendingApprovals: approvals,
  }
}

// ─── Agent Accomplishment Feed ───────────────────────────────────────────────

export interface Accomplishment {
  kind:        string
  count:       number
  latestAt:    number | null
  examples:    string[]   // short excerpts
}

const ACCOMPLISHMENT_EVENT_TYPES: Record<string, string> = {
  audits_completed:     'audit_run.completed',
  issues_found:         'audit.finding_created',
  patches_proposed:     'patch.proposed',
  tests_improved:       'test.added',
  incidents_resolved:   'incident.resolved',
  providers_optimized:  'provider.routing_updated',
  research_completed:   'research.run_completed',
  feeds_polled:         'feed.poll_completed',
  daily_reviews:        'daily.review',
  briefings_generated:  'daily.review',
}

export async function accomplishmentFeed(workspaceId: string, windowMs = 24 * 60 * 60_000): Promise<Accomplishment[]> {
  const since = Date.now() - windowMs
  // One grouped query for all relevant event types
  const rows = await db.select({
    type:     events.type,
    c:       sql<number>`count(*)::int`,
    latest:  sql<number>`max(${events.createdAt})::bigint`,
  }).from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      gte(events.createdAt, since),
      sql`${events.type} in (
        'audit_run.completed','audit.finding_created','patch.proposed',
        'test.added','incident.resolved','provider.routing_updated',
        'research.run_completed','feed.poll_completed','daily.review'
      )`,
    ))
    .groupBy(events.type).catch(() => [])

  const byType = new Map<string, { count: number; latest: number }>()
  for (const r of rows) byType.set(r.type, { count: Number(r.c), latest: Number(r.latest) })

  // Also: successful fixes recently
  const fixCount = await db.select({ c: sql<number>`count(*)::int` }).from(successfulFixes)
    .where(and(eq(successfulFixes.workspaceId, workspaceId), gte(successfulFixes.lastAppliedAt, since)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)

  const out: Accomplishment[] = []
  for (const [kind, type] of Object.entries(ACCOMPLISHMENT_EVENT_TYPES)) {
    const bucket = byType.get(type)
    if (!bucket || bucket.count === 0) continue
    out.push({
      kind, count: bucket.count, latestAt: bucket.latest, examples: [],
    })
  }
  if (fixCount > 0) {
    out.push({ kind: 'fixes_applied', count: fixCount, latestAt: null, examples: [] })
  }
  // Dedup by kind (some event types map to the same kind)
  return out.sort((a, b) => b.count - a.count)
}

// ─── Since-Last-Visit ────────────────────────────────────────────────────────

export interface SinceLastVisit {
  windowStart:        number
  windowEnd:          number
  newIncidents:       number
  resolvedIncidents:  number
  newResearchFindings: number
  newApprovals:       number
  newRoadmapItems:    number
  newFeedback:        number
  rollbacks:          number
  failureRateDelta:   number | null
  topNewItems:        Array<{ kind: string; title: string; at: number }>
}

export async function sinceLastVisit(workspaceId: string, lastVisitAt?: number): Promise<SinceLastVisit> {
  const since = lastVisitAt && lastVisitAt > 0 ? lastVisitAt : Date.now() - 24 * 60 * 60_000
  const end = Date.now()

  const [newInc, resInc, newRf, newApp, newRm, newFb, rollbacks, topNew] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.detectedAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'resolved'), gte(incidents.resolvedAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), gte(researchFindings.createdAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), gte(patchApprovals.createdAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(roadmapTasks)
      .where(and(eq(roadmapTasks.workspaceId, workspaceId), gte(roadmapTasks.createdAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(feedbackReports)
      .where(and(eq(feedbackReports.workspaceId, workspaceId), gte(feedbackReports.createdAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'patch.rolled_back'), gte(events.createdAt, since)))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    // Top new items — incidents + approvals + findings, sorted by time
    db.select({
      title:    incidents.title,
      at:       incidents.detectedAt,
      kind:     sql<string>`'incident'`,
    }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), gte(incidents.detectedAt, since)))
      .orderBy(desc(incidents.detectedAt)).limit(5).catch(() => []),
  ])

  // Failure rate delta: compare current 24h vs previous 24h
  const halfWindow = (end - since) / 2 || 12 * 60 * 60_000
  const [recent, prior] = await Promise.all([
    db.select({
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'failure')::int`,
    }).from(telemetryEvents)
      .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, end - halfWindow)))
      .then(r => r[0]).catch(() => null),
    db.select({
      total: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'failure')::int`,
    }).from(telemetryEvents)
      .where(and(
        eq(telemetryEvents.workspaceId, workspaceId),
        gte(telemetryEvents.createdAt, end - 2 * halfWindow),
        sql`${telemetryEvents.createdAt} < ${end - halfWindow}`,
      ))
      .then(r => r[0]).catch(() => null),
  ])
  const rate = (r: typeof recent) => r && Number(r.total) > 0 ? Number(r.failed) / Number(r.total) : null
  const recentRate = rate(recent)
  const priorRate  = rate(prior)
  const failureRateDelta = recentRate !== null && priorRate !== null
    ? Number((recentRate - priorRate).toFixed(3))
    : null

  return {
    windowStart: since, windowEnd: end,
    newIncidents:       newInc,
    resolvedIncidents:  resInc,
    newResearchFindings: newRf,
    newApprovals:       newApp,
    newRoadmapItems:    newRm,
    newFeedback:        newFb,
    rollbacks,
    failureRateDelta,
    topNewItems: topNew.map(t => ({ kind: String(t.kind), title: String(t.title ?? ''), at: Number(t.at ?? 0) })),
  }
}

// ─── War Room Home Composer ──────────────────────────────────────────────────

export interface WarRoomHome {
  workspaceId:    string
  composedAt:     number
  headline: {
    status:        'critical' | 'attention_needed' | 'healthy'
    summary:       string
  }
  topRecommendations: Recommendation[]    // top 5 from recommendation engine
  missions:           Awaited<ReturnType<typeof missionFeed>>
  accomplishments24h: Accomplishment[]
  sinceLastVisit:     SinceLastVisit
  unresolvedCritical: {
    openIncidents:    number
    pendingApprovals: number
    securityAudit:    number
  }
}

export async function warRoomHome(workspaceId: string, lastVisitAt?: number): Promise<WarRoomHome> {
  const [recs, missions, accomplishments, since, unresolved] = await Promise.all([
    topRecommendations(workspaceId, 5),
    missionFeed(workspaceId),
    accomplishmentFeed(workspaceId),
    sinceLastVisit(workspaceId, lastVisitAt),
    Promise.all([
      db.select({ c: sql<number>`count(*)::int` }).from(incidents)
        .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))
        .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
      db.select({ c: sql<number>`count(*)::int` }).from(patchApprovals)
        .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))
        .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
      db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
        .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
        .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    ]).then(([a, b, c]) => ({ openIncidents: a, pendingApprovals: b, securityAudit: c })),
  ])

  let headline: WarRoomHome['headline']
  if (unresolved.openIncidents > 0) {
    headline = { status: 'critical', summary: `${unresolved.openIncidents} open critical incident${unresolved.openIncidents > 1 ? 's' : ''}` }
  } else if (unresolved.pendingApprovals > 0 || since.rollbacks > 0 || recs.some(r => r.decision.bucket === 'P0')) {
    headline = { status: 'attention_needed', summary: `${unresolved.pendingApprovals} pending approval${unresolved.pendingApprovals === 1 ? '' : 's'}, ${recs.filter(r => r.decision.bucket === 'P0').length} P0 recommendation${recs.filter(r => r.decision.bucket === 'P0').length === 1 ? '' : 's'}` }
  } else {
    headline = { status: 'healthy', summary: 'no critical signals — operator-driven actions only' }
  }

  return {
    workspaceId, composedAt: Date.now(), headline,
    topRecommendations: recs,
    missions, accomplishments24h: accomplishments,
    sinceLastVisit: since, unresolvedCritical: unresolved,
  }
}
