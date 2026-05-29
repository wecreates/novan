/**
 * recap.ts — "while you were away" executive summary.
 *
 * Pure read-only aggregator over the events + issues + ideas + actions
 * tables. Returns structured sections; every count is a real query, not
 * a synthesized number.
 *
 * Section design (per the master prompt):
 *   - improvements   — cron completions, issues closed, ideas promoted
 *   - active         — pending approvals, open issues with proposals
 *   - alerts         — recent critical incidents, cron errors, blocked
 *                       connector actions
 *   - opportunities  — new ideas in 'validated' or 'blueprinted' state
 *   - learning       — recent event types that indicate self-update
 *
 * Boundary: `since` defaults to operator_presence.lastSeenAt for the
 * workspace; falls back to 24h ago if no presence row exists yet.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  events, issues, ideas, incidents, connectorActions,
  operatorPresence, codeProposals,
} from '../db/schema.js'

// ── Presence tracking ─────────────────────────────────────────────────

async function getOrInitPresence(workspaceId: string, operatorId = 'default') {
  const existing = await db.select().from(operatorPresence)
    .where(and(
      eq(operatorPresence.workspaceId, workspaceId),
      eq(operatorPresence.operatorId, operatorId),
    ))
    .limit(1).then(r => r[0]).catch(() => undefined)
  if (existing) return existing
  const now = Date.now()
  const fallback = now - 24 * 60 * 60_000  // 24h boundary on first ever poll
  await db.insert(operatorPresence).values({
    workspaceId, operatorId,
    lastSeenAt: fallback, lastPolledAt: now,
    createdAt: now, updatedAt: now,
  }).catch((e: Error) => { console.error('[recap]', e.message); return null })
  return { workspaceId, operatorId, lastSeenAt: fallback, lastPolledAt: now,
    createdAt: now, updatedAt: now }
}

/** Bump lastPolledAt without resetting the "while you were away" boundary. */
async function pollPresence(workspaceId: string, operatorId = 'default') {
  const now = Date.now()
  await db.update(operatorPresence)
    .set({ lastPolledAt: now, updatedAt: now })
    .where(and(
      eq(operatorPresence.workspaceId, workspaceId),
      eq(operatorPresence.operatorId, operatorId),
    ))
    .catch((e: Error) => { console.error('[recap]', e.message); return null })
}

/** Operator dismissed the recap — move the boundary to now. */
export async function acknowledgeRecap(workspaceId: string, operatorId = 'default') {
  const now = Date.now()
  await getOrInitPresence(workspaceId, operatorId)
  await db.update(operatorPresence)
    .set({ lastSeenAt: now, lastPolledAt: now, updatedAt: now })
    .where(and(
      eq(operatorPresence.workspaceId, workspaceId),
      eq(operatorPresence.operatorId, operatorId),
    ))
    .catch((e: Error) => { console.error('[recap]', e.message); return null })
  await db.insert(events).values({
    id: uuidv7(), type: 'recap.acknowledged', workspaceId,
    payload: { operatorId, at: now },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/recap', version: 1, createdAt: now,
  }).catch((e: Error) => { console.error('[recap]', e.message); return null })
}

// ── Result shape ──────────────────────────────────────────────────────

export interface RecapItem {
  /** Short, terse, human-readable. No emoji. No marketing prose. */
  label:    string
  /** Anchor for "deep dive" — leads back to the source row. */
  ref?:     { kind: 'issue' | 'idea' | 'incident' | 'action' | 'proposal' | 'event'; id: string }
  at:       number
}

export interface Recap {
  since:           number
  now:             number
  hasContent:      boolean
  improvements:    RecapItem[]
  active:          RecapItem[]
  alerts:          RecapItem[]
  opportunities:   RecapItem[]
  learning:        RecapItem[]
  /** Top-line one-liner for "While You Were Away" — strictly factual. */
  headline:        string
  /** Real counts used to generate headline (no inflation). */
  counts: {
    improvementsCount: number
    alertsCount:       number
    opportunitiesCount: number
    activeCount:       number
    pendingApprovals:  number
  }
}

// ── Aggregator ────────────────────────────────────────────────────────

export async function generateRecap(
  workspaceId: string,
  operatorId = 'default',
): Promise<Recap> {
  const now = Date.now()
  const presence = await getOrInitPresence(workspaceId, operatorId)
  const since = presence.lastSeenAt
  await pollPresence(workspaceId, operatorId)

  // ── Improvements ──────────────────────────────────────────────────
  // Things the brain finished while operator was gone: cron completions,
  // closed issues, promoted ideas. All real rows.
  const improvements: RecapItem[] = []

  // Closed/verified issues since boundary
  const verifiedIssues = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      inArray(issues.status, ['verified', 'closed']),
      gte(issues.updatedAt, since),
    ))
    .orderBy(desc(issues.updatedAt))
    .limit(10).catch(() => [])
  for (const i of verifiedIssues) {
    improvements.push({
      label: `${i.status === 'closed' ? 'Closed' : 'Verified'}: ${i.symptom.slice(0, 90)}`,
      ref:   { kind: 'issue', id: i.id },
      at:    i.updatedAt,
    })
  }

  // Promoted ideas
  const promotedIdeas = await db.select().from(ideas)
    .where(and(
      eq(ideas.workspaceId, workspaceId),
      eq(ideas.status, 'promoted'),
      gte(ideas.promotedAt, since),
    ))
    .orderBy(desc(ideas.promotedAt))
    .limit(5).catch(() => [])
  for (const idea of promotedIdeas) {
    improvements.push({
      label: `Promoted to business: ${idea.title.slice(0, 90)}`,
      ref:   { kind: 'idea', id: idea.id },
      at:    idea.promotedAt ?? idea.updatedAt,
    })
  }

  // Auto-loop completions (event-sourced count)
  const autoLoopEvents = await db.select({
    payload: events.payload, createdAt: events.createdAt,
  })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'cron.issue_auto_loop_completed'),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(20).catch(() => [])
  const autoLoopPromoted = autoLoopEvents.reduce((acc, e) => {
    const p = (e.payload as { promoted?: number } | null) ?? {}
    return acc + (p.promoted ?? 0)
  }, 0)
  if (autoLoopPromoted > 0) {
    improvements.push({
      label: `Auto-promoted ${autoLoopPromoted} diagnosed issue${autoLoopPromoted === 1 ? '' : 's'} to proposals`,
      at:    autoLoopEvents[0]?.createdAt ?? now,
    })
  }

  // ── Active work ──────────────────────────────────────────────────
  const active: RecapItem[] = []

  // Pending connector approvals
  const pendingApprovals = await db.select().from(connectorActions)
    .where(and(
      eq(connectorActions.workspaceId, workspaceId),
      eq(connectorActions.phase, 'awaiting_approval'),
    ))
    .orderBy(desc(connectorActions.createdAt))
    .limit(10).catch(() => [])
  for (const a of pendingApprovals) {
    active.push({
      label: `Approval needed: ${a.action} — ${a.intent.slice(0, 80)}`,
      ref:   { kind: 'action', id: a.id },
      at:    a.createdAt,
    })
  }

  // Proposals in 'proposed' or 'approved' state (work in flight)
  const inFlightProposals = await db.select().from(codeProposals)
    .where(and(
      eq(codeProposals.workspaceId, workspaceId),
      inArray(codeProposals.status, ['proposed', 'approved', 'executing']),
    ))
    .orderBy(desc(codeProposals.updatedAt))
    .limit(5).catch(() => [])
  for (const p of inFlightProposals) {
    active.push({
      label: `${p.status === 'proposed' ? 'Proposal awaiting review' : p.status === 'approved' ? 'Proposal approved, building' : 'Building'}: ${p.title.slice(0, 80)}`,
      ref:   { kind: 'proposal', id: p.id },
      at:    p.updatedAt,
    })
  }

  // ── Alerts ───────────────────────────────────────────────────────
  const alerts: RecapItem[] = []

  // Recent critical/emergency incidents
  const recentIncidents = await db.select().from(incidents)
    .where(and(
      eq(incidents.workspaceId, workspaceId),
      inArray(incidents.severity, ['critical', 'emergency']),
      gte(incidents.detectedAt, since),
      inArray(incidents.status, ['open', 'acknowledged', 'mitigating', 'escalated']),
    ))
    .orderBy(desc(incidents.detectedAt))
    .limit(10).catch(() => [])
  for (const i of recentIncidents) {
    alerts.push({
      label: `${i.severity.toUpperCase()}: ${i.title.slice(0, 90)}`,
      ref:   { kind: 'incident', id: i.id },
      at:    i.detectedAt,
    })
  }

  // Cron errors in the boundary window
  const cronErrorRows = await db.select({
    payload: events.payload, createdAt: events.createdAt, id: events.id,
  })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'cron.error'),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(10).catch(() => [])
  // Group by task name so 50 of the same error doesn't flood the recap
  const byCronTask = new Map<string, { count: number; latest: number; eventId: string; sample: string }>()
  for (const e of cronErrorRows) {
    const p = (e.payload as { task?: string; error?: string } | null) ?? {}
    const task = p.task ?? 'unknown'
    const ex = byCronTask.get(task)
    if (ex) { ex.count++; if (e.createdAt > ex.latest) { ex.latest = e.createdAt; ex.eventId = e.id } }
    else byCronTask.set(task, { count: 1, latest: e.createdAt, eventId: e.id, sample: (p.error ?? '').slice(0, 80) })
  }
  for (const [task, info] of byCronTask) {
    alerts.push({
      label: `Cron '${task}' failed ×${info.count}: ${info.sample}`,
      ref:   { kind: 'event', id: info.eventId },
      at:    info.latest,
    })
  }

  // Blocked + failed connector actions. Blocked = policy fired (good).
  // Failed = the handler threw (network, auth, validation). Both are
  // signals the operator should see in the recap.
  const blockedOrFailed = await db.select().from(connectorActions)
    .where(and(
      eq(connectorActions.workspaceId, workspaceId),
      inArray(connectorActions.phase, ['blocked', 'failed']),
      gte(connectorActions.createdAt, since),
    ))
    .orderBy(desc(connectorActions.createdAt))
    .limit(10).catch(() => [])
  for (const a of blockedOrFailed) {
    const prefix = a.phase === 'blocked' ? 'Blocked' : 'Failed'
    const reason = a.phase === 'blocked' ? (a.blockedReason ?? 'policy violation')
                                         : (a.errorMessage  ?? 'handler error')
    alerts.push({
      label: `${prefix}: ${a.action} — ${reason}`,
      ref:   { kind: 'action', id: a.id },
      at:    a.createdAt,
    })
  }

  // ── Opportunities ────────────────────────────────────────────────
  const opportunities: RecapItem[] = []

  const newIdeas = await db.select().from(ideas)
    .where(and(
      eq(ideas.workspaceId, workspaceId),
      inArray(ideas.status, ['validated', 'blueprinted']),
      gte(ideas.updatedAt, since),
    ))
    .orderBy(desc(ideas.updatedAt))
    .limit(8).catch(() => [])
  for (const idea of newIdeas) {
    opportunities.push({
      label: `${idea.status === 'blueprinted' ? 'Ready to build' : 'Validated idea'}: ${idea.title.slice(0, 90)}`,
      ref:   { kind: 'idea', id: idea.id },
      at:    idea.updatedAt,
    })
  }

  // ── Learning ─────────────────────────────────────────────────────
  // Real "what the brain learned" = ingest counts + skill_library use.
  const learning: RecapItem[] = []
  const ingestEvents = await db.select({
    payload: events.payload, createdAt: events.createdAt,
  })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      eq(events.type, 'cron.issue_ingest_completed'),
      gte(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(10).catch(() => [])
  const created = ingestEvents.reduce((a, e) => a + (((e.payload as { created?: number } | null) ?? {}).created ?? 0), 0)
  if (created > 0) {
    learning.push({
      label: `Ingested ${created} new issue${created === 1 ? '' : 's'} from runtime signals`,
      at:    ingestEvents[0]?.createdAt ?? now,
    })
  }

  // Sort sections by time desc + cap so the UI stays calm
  const trim = (arr: RecapItem[]) => arr.sort((a, b) => b.at - a.at).slice(0, 8)
  const sections = {
    improvements:  trim(improvements),
    active:        trim(active),
    alerts:        trim(alerts),
    opportunities: trim(opportunities),
    learning:      trim(learning),
  }

  const counts = {
    improvementsCount:  sections.improvements.length,
    alertsCount:        sections.alerts.length,
    opportunitiesCount: sections.opportunities.length,
    activeCount:        sections.active.length,
    pendingApprovals:   pendingApprovals.length,
  }

  const headline = composeHeadline(counts, since, now)
  const hasContent = sections.improvements.length + sections.active.length +
    sections.alerts.length + sections.opportunities.length + sections.learning.length > 0

  return { since, now, hasContent, ...sections, headline, counts }
}

function composeHeadline(c: Recap['counts'], since: number, now: number): string {
  const hours = Math.max(1, Math.round((now - since) / 3_600_000))
  const window = hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
  const parts: string[] = []
  if (c.improvementsCount   > 0) parts.push(`${c.improvementsCount} improvement${c.improvementsCount === 1 ? '' : 's'}`)
  if (c.alertsCount         > 0) parts.push(`${c.alertsCount} alert${c.alertsCount === 1 ? '' : 's'}`)
  if (c.opportunitiesCount  > 0) parts.push(`${c.opportunitiesCount} opportunit${c.opportunitiesCount === 1 ? 'y' : 'ies'}`)
  // activeCount includes pending approvals, so subtract to avoid double-count
  const activeNonApproval = Math.max(0, c.activeCount - c.pendingApprovals)
  if (activeNonApproval > 0) parts.push(`${activeNonApproval} item${activeNonApproval === 1 ? '' : 's'} in flight`)
  if (c.pendingApprovals    > 0) parts.push(`${c.pendingApprovals} approval${c.pendingApprovals === 1 ? '' : 's'} pending`)
  if (parts.length === 0) return `Quiet — no significant activity in the last ${window}.`
  return `Last ${window}: ${parts.join(', ')}.`
}

// Suppress unused-import warning on sql — kept in case downstream queries grow
void sql
