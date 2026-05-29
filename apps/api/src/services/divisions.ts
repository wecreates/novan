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
  imageGenerations, killSwitches, workflowRuns,
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
          summary: summarizeEventPayload(r.type, r.payload),
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

  // Research feed failure rate >50% → blocks product + growth (signals stale data)
  const feedStats = await db.select({
    success: sql<number>`count(*) filter (where ${events.type} = 'feed.poll_completed')::int`,
    failed:  sql<number>`count(*) filter (where ${events.type} = 'feed.poll_failed')::int`,
  }).from(events)
    .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} like 'feed.%'`, gte(events.createdAt, now - 2 * DAY)))
    .then(r => r[0] ?? { success: 0, failed: 0 }).catch(() => ({ success: 0, failed: 0 }))
  const totalFeed = Number(feedStats.success) + Number(feedStats.failed)
  if (totalFeed >= 4 && Number(feedStats.failed) / totalFeed > 0.5) {
    out.push({
      from: 'research',
      to:   ['product', 'growth'],
      blockerId: 'feed_failure:48h',
      kind: 'failed_workflow',
      title: `Research feed failure rate ${Math.round((Number(feedStats.failed)/totalFeed)*100)}% (last 48h) — downstream insights stale`,
      severity: 'medium',
      ageDays: 0,
    })
  }

  // Budget cap > 90% → blocks all autonomous divisions
  const { providerBudgets: pb } = await import('../db/schema.js')
  const budgetRow = await db.select().from(pb).where(eq(pb.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch(() => null)
  if (budgetRow) {
    const dailyPct = budgetRow.dailyLimitUsd > 0 ? budgetRow.dailySpendUsd / budgetRow.dailyLimitUsd : 0
    if (dailyPct > 0.9) {
      out.push({
        from: 'infrastructure',
        to:   ['engineering', 'research', 'growth', 'operations'],
        blockerId: 'budget:daily_90pct',
        kind: 'audit_cluster',
        title: `Daily budget at ${Math.round(dailyPct*100)}% — autonomous AI calls likely throttled`,
        severity: dailyPct > 0.95 ? 'critical' : 'high',
        ageDays: 0,
      })
    }
  }

  // Open patch approvals waiting >24h → blocks engineering + ops
  const { patchApprovals: pa } = await import('../db/schema.js')
  const stalePending = await db.select({ c: sql<number>`count(*)::int` }).from(pa)
    .where(and(eq(pa.workspaceId, workspaceId), eq(pa.status, 'pending'), sql`${pa.createdAt} < ${now - DAY}`))
    .then(r => Number(r[0]?.c ?? 0)).catch(() => 0)
  if (stalePending > 0) {
    out.push({
      from: 'operations',
      to:   ['engineering'],
      blockerId: 'pending_approvals:stale',
      kind: 'pending_approval',
      title: `${stalePending} pending patch approval(s) waiting >24h — engineering flow stalled`,
      severity: stalePending >= 5 ? 'high' : 'medium',
      ageDays: 1,
    })
  }

  return out
}

// ─── Premium event-summary renderer ──────────────────────────────────────────

/** Convert a raw event payload into a one-line operator-facing summary. */
export function summarizeEventPayload(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>
  const getStr = (k: string) => (typeof p[k] === 'string' ? p[k] as string : null)
  const getNum = (k: string) => (typeof p[k] === 'number' ? p[k] as number : null)

  if (type === 'patch.applied')           return `${getStr('filePath') ?? 'patch'} (+${getNum('linesAdded') ?? 0}/-${getNum('linesRemoved') ?? 0})`
  if (type === 'patch.rolled_back')       return `${getStr('filePath') ?? 'patch'} rolled back: ${getStr('reason') ?? 'unknown'}`
  if (type === 'patch.blocked_by_governance') return `blocked: ${getStr('reason') ?? 'governance'}`
  if (type === 'research.run_completed')  return `${getNum('findingsAdded') ?? 0} findings · ${getNum('duplicates') ?? 0} dups`
  if (type === 'research.finding_added')  return `${getStr('factType') ?? 'finding'} from ${getStr('url') ?? '?'} (conf ${getNum('confidence') ?? '?'})`
  if (type === 'feed.poll_completed')     return `${getStr('feedUrl') ?? '?'}: ${getNum('itemsIngested') ?? 0} new / ${getNum('itemsCached') ?? 0} cached`
  if (type === 'incident.opened')         return `${getStr('severity') ?? ''} ${getStr('title') ?? ''}`
  if (type === 'incident.resolved')       return `${getStr('title') ?? ''} (resolved)`
  if (type === 'governance.auto_throttle_engaged') return `engaged: ${Array.isArray(p['engaged']) ? (p['engaged'] as string[]).join(', ') : ''}`
  if (type === 'governance.auto_throttle_disengaged') return `released: ${Array.isArray(p['disengaged']) ? (p['disengaged'] as string[]).join(', ') : ''}`
  if (type === 'governance.agent_auto_paused') return `agent ${getStr('agentId') ?? '?'} paused (${getNum('failures') ?? 0} fails)`
  if (type === 'web_fetch.completed')     return `${getStr('url') ?? '?'} (${getNum('contentBytes') ?? 0}b)`
  if (type === 'image.generation_completed') return `${getStr('provider') ?? '?'}: $${getNum('costUsd') ?? 0}`
  if (type === 'image.blocked')           return `blocked: ${getStr('reason') ?? '?'}`
  if (type === 'cron.research_scan_completed') return `${getNum('runs') ?? 0} topics scanned, ${getNum('findings') ?? 0} findings`
  if (type === 'daily.review')            return `daily review emitted`
  if (type === 'briefing.weekly_executive') return `weekly briefing emitted`

  // Default: short slice
  return JSON.stringify(payload).slice(0, 100)
}

// ─── Division-level forecasting ──────────────────────────────────────────────

import { generateForecasts as wsForecasts } from './forecasting.js'

const DIVISION_FORECAST_TYPES: Record<Division, string[]> = {
  engineering:    ['runtime_bottleneck_likely', 'deployment_instability_likely'],
  security:       ['security_risk_growing'],
  operations:     ['runtime_bottleneck_likely', 'scaling_pressure_growing'],
  research:       [],
  product:        [],
  growth:         [],
  support:        [],
  infrastructure: ['provider_failure_likely', 'budget_overrun_likely', 'scaling_pressure_growing'],
}

export async function forecastsByDivision(workspaceId: string, division: Division) {
  const all = await wsForecasts(workspaceId)
  const types = new Set(DIVISION_FORECAST_TYPES[division])
  return {
    division,
    forecasts: all.forecasts.filter(f => types.has(f.type)),
    generatedAt: all.generatedAt,
  }
}

// ─── Cross-division priority search ──────────────────────────────────────────

export async function searchByTag(workspaceId: string, tag: string) {
  const lower = tag.toLowerCase()
  const missions = await db.select().from(strategicGoals)
    .where(and(eq(strategicGoals.workspaceId, workspaceId), sql`${strategicGoals.tags} @> ARRAY[${lower}]::text[]`))
    .catch(() => [])
  return {
    tag: lower,
    missions: missions.map(m => ({
      id: m.id, title: String(m.title ?? ''),
      horizon: String(m.horizon ?? ''),
      status: String(m.status ?? ''),
      progress: Number(m.progress ?? 0),
      tags: (Array.isArray(m.tags) ? m.tags : []) as string[],
      // Determine which divisions this mission spans by intersecting tags with DIVISIONS
      divisions: ((Array.isArray(m.tags) ? m.tags : []) as string[]).filter(t => (DIVISIONS as readonly string[]).includes(t)),
    })),
  }
}

// ─── Organizational agents (engineering/operations/infrastructure) ──────────

/**
 * Agent definitions for divisions that the research seed doesn't cover.
 * Idempotent — only inserts agents that don't already exist for the type.
 */
const ORG_AGENT_DEFS: Array<{ name: string; type: string; capabilities: string[] }> = [
  // Engineering
  { name: 'Runtime Architect',       type: 'runtime_architect',     capabilities: ['workflow.design', 'orchestration.review'] },
  { name: 'Backend Engineer',        type: 'backend_engineer',      capabilities: ['api.build', 'queue.optimize', 'db.tune'] },
  { name: 'Frontend Engineer',       type: 'frontend_engineer',     capabilities: ['ui.build', 'render.optimize'] },
  { name: 'Reliability Engineer',    type: 'reliability_engineer',  capabilities: ['recovery.design', 'rollback.validate'] },
  { name: 'QA Engineer',             type: 'qa_engineer',           capabilities: ['test.author', 'smoke.run', 'edge.discover'] },
  { name: 'Patch Executor',          type: 'patch_executor',        capabilities: ['patch.apply', 'rollback.execute'] },
  { name: 'Reviewer',                type: 'reviewer',              capabilities: ['patch.review', 'risk.assess'] },
  // Operations
  { name: 'CTO',                     type: 'cto',                   capabilities: ['strategy', 'architecture.review'] },
  { name: 'Mission Planner',         type: 'mission_planner',       capabilities: ['roadmap.compose', 'priority.balance'] },
  { name: 'Orchestrator',            type: 'orchestrator',          capabilities: ['agent.coordinate', 'workflow.dispatch'] },
  // Infrastructure
  { name: 'Infrastructure Engineer', type: 'infrastructure',        capabilities: ['deploy.manage', 'scaling.tune'] },
  // Security (the additional types beyond security_research)
  { name: 'Chief Security Officer',  type: 'chief_security',        capabilities: ['security.strategy', 'incident.escalate'] },
  { name: 'AppSec Engineer',         type: 'appsec',                capabilities: ['code.scan', 'api.security'] },
  { name: 'Cloud Security Engineer', type: 'cloud_security',        capabilities: ['infra.harden', 'tenant.isolate'] },
  { name: 'Runtime Threat Detector', type: 'runtime_threat_detection', capabilities: ['abuse.detect', 'exploit.detect'] },
  { name: 'Secrets Security Engineer', type: 'secrets_security',    capabilities: ['secret.scan', 'rotation.audit'] },
  { name: 'Tenant Isolation Engineer', type: 'tenant_isolation',    capabilities: ['rbac.validate', 'workspace.isolate'] },
  { name: 'Red Team Agent',          type: 'red_team',              capabilities: ['adversarial.test', 'vuln.discover'] },
  { name: 'Blue Team Agent',         type: 'blue_team',             capabilities: ['mitigation.deploy', 'incident.respond'] },
  { name: 'Compliance Auditor',      type: 'compliance',            capabilities: ['audit.retain', 'policy.verify'] },
]

export async function seedOrganizationalAgents(workspaceId: string): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0
  const now = Date.now()
  for (const def of ORG_AGENT_DEFS) {
    const existing = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.type, def.type)))
      .limit(1).then(r => r[0]).catch(() => null)
    if (existing) { skipped++; continue }
    const { v7: uuidv7 } = await import('uuid')
    await db.insert(agents).values({
      id: uuidv7(), workspaceId, name: def.name, type: def.type,
      description: `Organizational agent: ${def.name}`,
      capabilities: [...def.capabilities],
      config: {}, status: 'idle',
      createdAt: now, updatedAt: now,
    }).catch(() => null)
    created++
  }
  return { created, skipped }
}

// ─── Mission auto-tagging ────────────────────────────────────────────────────

/**
 * Infer a division tag from a mission's title + existing tags. Operator
 * keeps explicit tags they set; we only add what they didn't.
 */
function inferDivisionTags(title: string, existing: string[]): Division[] {
  const t = (title ?? '').toLowerCase()
  const has = (s: string) => t.includes(s)
  const out = new Set<Division>()
  if (has('frontend') || has('ui') || has('web') || has('render')) out.add('engineering')
  if (has('deploy') || has('vercel') || has('docker') || has('compose') || has('cdn')) out.add('infrastructure')
  if (has('research') || has('learn') || has('feed') || has('source')) out.add('research')
  if (has('feedback') || has('telemetry') || has('product')) out.add('product')
  if (has('growth') || has('market') || has('adoption') || has('pricing')) out.add('growth')
  if (has('support') || has('help') || has('user')) out.add('support')
  if (has('security') || has('audit') || has('rbac')) out.add('security')
  if (has('incident') || has('reliability') || has('runtime') || has('ops')) out.add('operations')
  if (has('backend') || has('api') || has('queue') || has('patch') || has('test')) out.add('engineering')

  // Strip any divisions already in the existing tag list
  for (const e of existing) if ((DIVISIONS as readonly string[]).includes(e)) out.delete(e as Division)
  return [...out]
}

export interface AutoTagResult {
  scanned:   number
  updated:   number
  bindings:  Array<{ missionId: string; title: string; added: Division[] }>
}

/** Apply inferred division tags to all missions that lack one. */
export async function autoTagMissions(workspaceId: string): Promise<AutoTagResult> {
  const rows = await db.select().from(strategicGoals)
    .where(eq(strategicGoals.workspaceId, workspaceId))
    .catch(() => [])

  const result: AutoTagResult = { scanned: rows.length, updated: 0, bindings: [] }
  for (const r of rows) {
    const existing = (Array.isArray(r.tags) ? r.tags : []) as string[]
    // Already has at least one division tag → skip
    if (existing.some(t => (DIVISIONS as readonly string[]).includes(t))) continue
    const added = inferDivisionTags(String(r.title ?? ''), existing)
    if (added.length === 0) continue
    await db.update(strategicGoals).set({
      tags: [...existing, ...added], updatedAt: Date.now(),
    }).where(eq(strategicGoals.id, r.id)).catch(() => null)
    result.updated++
    result.bindings.push({ missionId: r.id, title: String(r.title ?? '').slice(0, 80), added })
  }
  return result
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
