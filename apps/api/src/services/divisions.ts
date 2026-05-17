/**
 * divisions.ts — 8 logical operational divisions over existing tables.
 *
 * Divisions are NOT a new table — they're filters over agent types,
 * audit categories, recommendation kinds, mission tags, and event
 * sources. Mapping is explicit and auditable below.
 *
 * Each division surfaces:
 *   - missions (from strategic_goals tagged with the division name)
 *   - priorities (top recs of that division's kinds)
 *   - operational metrics (counts from real tables, filtered)
 *   - blockers (open incidents/audit/feedback in the division's scope)
 *   - recommendations (recommendation-engine filtered by division)
 */
import { db }                          from '../db/client.js'
import {
  agents, strategicGoals, incidents, auditFindings, events,
  researchFindings, researchTopics, feedbackReports, telemetryEvents,
  imageGenerations, providerHealthLog, killSwitches, workflowRuns,
} from '../db/schema.js'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { generateRecommendations, type Recommendation, type RecKind } from './recommendation-engine.js'

const DAY  = 24 * 60 * 60_000
const WEEK = 7 * DAY

export const DIVISIONS = [
  'engineering',
  'security',
  'operations',
  'research',
  'product',
  'growth',
  'support',
  'infrastructure',
] as const
export type Division = (typeof DIVISIONS)[number]

// ─── Division mapping (explicit, auditable) ──────────────────────────────────

/** Recommendation kinds owned by each division. */
const DIVISION_REC_KINDS: Record<Division, RecKind[]> = {
  engineering:    ['reliability_improvement', 'performance_bottleneck', 'critical_runtime_fix'],
  security:       ['security_risk'],
  operations:     ['critical_runtime_fix', 'operator_approval'],
  research:       [],
  product:        ['operator_approval'],
  growth:         ['growth_opportunity'],
  support:        ['operator_approval'],
  infrastructure: ['budget_optimization', 'performance_bottleneck'],
}

/** Agent types owned by each division. */
const DIVISION_AGENT_TYPES: Record<Division, string[]> = {
  engineering:    ['runtime_architect', 'backend_engineer', 'frontend_engineer', 'reliability_engineer', 'qa_engineer', 'patch_executor', 'reviewer'],
  security:       ['chief_security', 'appsec', 'cloud_security', 'runtime_threat_detection', 'secrets_security', 'tenant_isolation', 'red_team', 'blue_team', 'compliance', 'security_research'],
  operations:     ['cto', 'mission_planner', 'orchestrator'],
  research:       ['research_planner', 'web_research', 'source_quality', 'fact_checker', 'memory_curator', 'trend_detection', 'competitive_intelligence', 'product_research', 'market_research'],
  product:        ['ux_insight', 'workflow_friction', 'product_research'],
  growth:         ['adoption', 'market_research', 'competitive_intelligence'],
  support:        ['workflow_friction'],
  infrastructure: ['infrastructure', 'cloud_security', 'reliability_trend'],
}

/** Audit-finding categories owned by each division. */
const DIVISION_AUDIT_CATEGORIES: Record<Division, string[]> = {
  engineering:    ['code_quality', 'reliability', 'runtime', 'optimization', 'performance', 'testing'],
  security:       ['security'],
  operations:     ['runtime', 'reliability'],
  research:       [],
  product:        [],
  growth:         [],
  support:        [],
  infrastructure: ['performance', 'optimization'],
}

/** Event-type prefixes owned by each division. */
const DIVISION_EVENT_PREFIXES: Record<Division, string[]> = {
  engineering:    ['patch.', 'workflow.', 'audit.', 'test.'],
  security:       ['governance.', 'security.', 'audit.finding'],
  operations:     ['incident.', 'cron.', 'orchestrator.'],
  research:       ['research.', 'feed.'],
  product:        ['feedback.', 'telemetry.'],
  growth:         ['image.', 'research.finding'],
  support:        ['feedback.'],
  infrastructure: ['provider.', 'governor.', 'image.'],
}

// ─── Division snapshot ───────────────────────────────────────────────────────

export interface DivisionSnapshot {
  division:        Division
  capturedAt:      number
  health:          'thriving' | 'healthy' | 'attention' | 'critical'
  metrics: {
    activeAgents:    number
    activeMissions:  number
    openBlockers:    number
    eventsLast24h:   number
  }
  missions: {
    active:    Array<{ id: string; title: string; horizon: string; progress: number; targetDate: number | null }>
    completed: number
    total:     number
  }
  blockers:        Array<{ kind: string; title: string; severity?: string; createdAt: number }>
  recommendations: Recommendation[]
  recentReports:   Array<{ type: string; at: number; summary: string }>
}

function classifyHealth(opts: { criticalBlockers: number; openBlockers: number; activeMissions: number; activeAgents: number }): DivisionSnapshot['health'] {
  if (opts.criticalBlockers > 0) return 'critical'
  if (opts.openBlockers >= 5)     return 'attention'
  if (opts.activeAgents === 0 && opts.activeMissions === 0) return 'attention'
  if (opts.activeMissions > 0 && opts.openBlockers === 0)   return 'thriving'
  return 'healthy'
}

export async function divisionSnapshot(workspaceId: string, division: Division): Promise<DivisionSnapshot> {
  const now = Date.now()
  const dayAgo = now - DAY

  const agentTypes      = DIVISION_AGENT_TYPES[division]
  const auditCategories = DIVISION_AUDIT_CATEGORIES[division]
  const recKinds        = DIVISION_REC_KINDS[division]
  const eventPrefixes   = DIVISION_EVENT_PREFIXES[division]

  const [activeAgents, divMissions, openInc, auditOpen, fbOpen, evCount, allRecs] = await Promise.all([
    agentTypes.length > 0
      ? db.select({ c: sql<number>`count(*)::int` }).from(agents)
          .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.type, agentTypes)))
          .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
      : Promise.resolve(0),

    db.select().from(strategicGoals)
      .where(and(
        eq(strategicGoals.workspaceId, workspaceId),
        sql`${strategicGoals.tags} @> ARRAY[${division}]::text[]`,
      ))
      .catch(() => []),

    db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .catch(() => []),

    auditCategories.length > 0
      ? db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
          .where(and(eq(auditFindings.workspaceId, workspaceId), inArray(auditFindings.category, auditCategories)))
          .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
      : Promise.resolve(0),

    db.select({ c: sql<number>`count(*)::int` }).from(feedbackReports)
      .where(and(eq(feedbackReports.workspaceId, workspaceId), eq(feedbackReports.status, 'open')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    eventPrefixes.length > 0
      ? db.select({ c: sql<number>`count(*)::int` }).from(events)
          .where(and(
            eq(events.workspaceId, workspaceId),
            gte(events.createdAt, dayAgo),
            sql`(${sql.join(eventPrefixes.map(p => sql`${events.type} like ${p + '%'}`), sql` OR `)})`,
          ))
          .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
      : Promise.resolve(0),

    generateRecommendations(workspaceId).catch(() => [] as Recommendation[]),
  ])

  // Filter incidents to division scope: severity-based for ops/security, otherwise all
  const divisionIncidents = division === 'operations' || division === 'security' || division === 'engineering'
    ? openInc
    : []

  const criticalBlockers = divisionIncidents.filter(i => i.severity === 'critical').length
  const openBlockersCount = divisionIncidents.length + (division === 'support' ? fbOpen : 0)

  // Map recs to division kinds (filter by RecKind set)
  const divRecs = recKinds.length > 0
    ? allRecs.filter(r => recKinds.includes(r.kind)).slice(0, 5)
    : []

  // Recent reports = recent events with this division's prefixes
  const recentReports = eventPrefixes.length > 0
    ? await db.select({
        type: events.type, at: events.createdAt, payload: events.payload,
      }).from(events)
        .where(and(
          eq(events.workspaceId, workspaceId),
          gte(events.createdAt, dayAgo),
          sql`(${sql.join(eventPrefixes.map(p => sql`${events.type} like ${p + '%'}`), sql` OR `)})`,
        ))
        .orderBy(desc(events.createdAt))
        .limit(8)
        .then(rs => rs.map(r => ({
          type: r.type,
          at: Number(r.at),
          summary: JSON.stringify(r.payload).slice(0, 140),
        }))).catch(() => [])
    : []

  return {
    division, capturedAt: now,
    health: classifyHealth({
      criticalBlockers,
      openBlockers: openBlockersCount + (auditOpen > 0 ? 1 : 0),
      activeMissions: divMissions.filter(m => m.status === 'active').length,
      activeAgents,
    }),
    metrics: {
      activeAgents,
      activeMissions: divMissions.filter(m => m.status === 'active').length,
      openBlockers:   openBlockersCount,
      eventsLast24h:  evCount,
    },
    missions: {
      active: divMissions
        .filter(m => m.status === 'active')
        .map(m => ({
          id: m.id, title: String(m.title ?? ''),
          horizon: String(m.horizon ?? ''),
          progress: Number(m.progress ?? 0),
          targetDate: m.targetDate as number | null,
        })),
      completed: divMissions.filter(m => m.status === 'completed').length,
      total:     divMissions.length,
    },
    blockers: [
      ...divisionIncidents.slice(0, 8).map(i => ({
        kind: 'incident',
        title: String(i.title ?? ''),
        severity: String(i.severity ?? ''),
        createdAt: Number(i.detectedAt ?? 0),
      })),
      ...(auditOpen > 0 ? [{
        kind: 'audit_findings_cluster',
        title: `${auditOpen} ${division} audit findings`,
        createdAt: now,
      }] : []),
    ],
    recommendations: divRecs,
    recentReports,
  }
}

export async function allDivisionsSnapshot(workspaceId: string): Promise<Record<Division, DivisionSnapshot>> {
  const out = {} as Record<Division, DivisionSnapshot>
  for (const d of DIVISIONS) {
    out[d] = await divisionSnapshot(workspaceId, d)
  }
  return out
}

// ─── Inter-division coordination ─────────────────────────────────────────────

export interface CrossDivisionBlocker {
  from:        Division
  to:          Division[]
  blockerId:   string
  kind:        'incident' | 'audit_cluster' | 'pending_approval' | 'failed_workflow'
  title:       string
  severity:    string
  ageDays:     number
}

export async function crossDivisionBlockers(workspaceId: string): Promise<CrossDivisionBlocker[]> {
  const now = Date.now()
  const out: CrossDivisionBlocker[] = []

  // Open critical incidents → block ops, eng, security
  const crits = await db.select().from(incidents)
    .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))
    .catch(() => [])
  for (const inc of crits) {
    out.push({
      from: 'operations',
      to:   ['engineering', 'security', 'infrastructure'],
      blockerId: inc.id,
      kind: 'incident',
      title: String(inc.title ?? ''),
      severity: 'critical',
      ageDays: Math.floor((now - Number(inc.detectedAt ?? 0)) / DAY),
    })
  }

  // Security audit findings → block engineering deploys
  const secCount = await db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
    .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  if (secCount > 5) {
    out.push({
      from: 'security',
      to:   ['engineering', 'operations'],
      blockerId: 'audit:security:cluster',
      kind: 'audit_cluster',
      title: `${secCount} security audit findings — engineering deploys should wait until triaged`,
      severity: 'high',
      ageDays: 0,
    })
  }

  // Recent deployment failures → block infrastructure + product
  const deployFails = await db.select({ c: sql<number>`count(*)::int` }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), eq(events.type, 'deployment.failed'), gte(events.createdAt, now - DAY)))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  if (deployFails >= 2) {
    out.push({
      from: 'infrastructure',
      to:   ['engineering', 'product'],
      blockerId: 'deploy_fail:24h',
      kind: 'failed_workflow',
      title: `${deployFails} deployment failures in last 24h`,
      severity: 'high',
      ageDays: 0,
    })
  }

  return out
}

// ─── Company-wide priority summary ───────────────────────────────────────────

export async function companyMissionStatus(workspaceId: string) {
  const rows = await db.select({
    status: strategicGoals.status,
    horizon: strategicGoals.horizon,
    c: sql<number>`count(*)::int`,
    avgProgress: sql<number>`coalesce(avg(${strategicGoals.progress}), 0)::float`,
  }).from(strategicGoals)
    .where(eq(strategicGoals.workspaceId, workspaceId))
    .groupBy(strategicGoals.status, strategicGoals.horizon)
    .catch(() => [])

  return rows.map(r => ({
    status: r.status, horizon: r.horizon,
    count: Number(r.c), avgProgress: Number(Number(r.avgProgress).toFixed(2)),
  }))
}
