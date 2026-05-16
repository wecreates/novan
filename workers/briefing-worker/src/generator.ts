/**
 * Briefing generator — pulls live data from DB and synthesises
 * structured sections.  Every item carries source + provenance.
 * Low-confidence items (< 0.70) are flagged automatically.
 */
import { eq, and, desc, gt, isNotNull, inArray, sql } from 'drizzle-orm'
import type { DbClient }  from '@ops/db'
import {
  workflowRuns, approvals,
  memories, risks, opportunities, insights, events,
  briefings, briefingItems,
} from '@ops/db'
import { v7 as uuidv7 }  from 'uuid'

const LOW_CONF_THRESHOLD = 0.70

export interface BriefingItem {
  id:              string
  section:         string
  title:           string
  body:            string
  confidence:      number
  isLowConfidence: boolean
  source:          string
  sourceRef:       string | null
  sourceLabel:     string | null
  priority:        number
  metadata:        Record<string, unknown>
}

export interface GeneratedBriefing {
  summary: string
  items:   BriefingItem[]
}

// ─── Section builders ─────────────────────────────────────────────────────────

async function buildTopPriorities(
  db: DbClient, workspaceId: string, _since: number,
): Promise<BriefingItem[]> {
  const items: BriefingItem[] = []

  // Pending approvals = highest priority blocking items
  const pendingApprovals = await db.select({
    id: approvals.id, runId: approvals.runId, operationLabel: approvals.operationLabel,
    risk: approvals.risk, expiresAt: approvals.expiresAt, requestedAt: approvals.requestedAt,
  })
    .from(approvals)
    .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, 'pending')))
    .orderBy(desc(approvals.requestedAt))
    .limit(5)

  for (const a of pendingApprovals) {
    const ageMin = Math.round((Date.now() - a.requestedAt) / 60_000)
    const conf = a.risk === 'critical' ? 0.95 : a.risk === 'high' ? 0.90 : 0.80
    items.push({
      id:              uuidv7(),
      section:         'top_priorities',
      title:           `Approval pending: ${a.operationLabel}`,
      body:            `Risk level ${a.risk}. Waiting ${ageMin} min. Expires ${new Date(a.expiresAt).toISOString()}.`,
      confidence:      conf,
      isLowConfidence: conf < LOW_CONF_THRESHOLD,
      source:          'approvals',
      sourceRef:       a.id,
      sourceLabel:     `Approval for run ${a.runId}`,
      priority:        a.risk === 'critical' ? 100 : a.risk === 'high' ? 90 : 70,
      metadata:        { runId: a.runId, risk: a.risk },
    })
  }

  // High-priority open risks
  const highRisks = await db.select({ id: risks.id, title: risks.title, riskScore: risks.riskScore, severity: risks.severity })
    .from(risks)
    .where(and(
      eq(risks.workspaceId, workspaceId),
      eq(risks.status, 'open'),
      inArray(risks.severity, ['high', 'critical']),
    ))
    .orderBy(desc(risks.riskScore))
    .limit(3)

  for (const r of highRisks) {
    items.push({
      id:              uuidv7(),
      section:         'top_priorities',
      title:           `High risk: ${r.title}`,
      body:            `Severity ${r.severity}, risk score ${(r.riskScore * 100).toFixed(0)}%.`,
      confidence:      0.85,
      isLowConfidence: false,
      source:          'risks',
      sourceRef:       r.id,
      sourceLabel:     `Risk: ${r.title}`,
      priority:        r.severity === 'critical' ? 95 : 80,
      metadata:        { severity: r.severity, riskScore: r.riskScore },
    })
  }

  return items
}

async function buildBlockedWorkflows(
  db: DbClient, workspaceId: string, _since: number,
): Promise<BriefingItem[]> {
  // Runs stuck in 'running' or 'awaiting_approval' for > 30 min
  const stallThreshold = Date.now() - 30 * 60_000

  const blocked = await db.select({
    id: workflowRuns.id, status: workflowRuns.status,
    workflowId: workflowRuns.workflowId, startedAt: workflowRuns.startedAt,
    errorMessage: workflowRuns.errorMessage, traceId: workflowRuns.traceId,
  })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.workspaceId, workspaceId),
      inArray(workflowRuns.status, ['running', 'awaiting_approval', 'paused', 'failed']),
    ))
    .orderBy(desc(workflowRuns.triggeredAt))
    .limit(10)

  const items: BriefingItem[] = []
  for (const r of blocked) {
    const stallMin = r.startedAt ? Math.round((Date.now() - r.startedAt) / 60_000) : 0
    const isStalled = r.status === 'running' && r.startedAt !== null && r.startedAt < stallThreshold
    const isFailed  = r.status === 'failed'

    if (!isStalled && !isFailed && r.status !== 'awaiting_approval' && r.status !== 'paused') continue

    const conf = isFailed ? 0.95 : r.status === 'awaiting_approval' ? 0.90 : 0.75
    const title = isFailed
      ? `Failed workflow: ${r.workflowId}`
      : r.status === 'awaiting_approval'
        ? `Awaiting approval: ${r.workflowId}`
        : r.status === 'paused'
          ? `Paused workflow: ${r.workflowId}`
          : `Stalled workflow: ${r.workflowId} (${stallMin} min)`

    items.push({
      id:              uuidv7(),
      section:         'blocked_workflows',
      title,
      body:            isFailed
        ? `Error: ${r.errorMessage ?? 'unknown'}. Run ${r.id}.`
        : `Run ${r.id} has been in state "${r.status}" for ${stallMin} min.`,
      confidence:      conf,
      isLowConfidence: conf < LOW_CONF_THRESHOLD,
      source:          'workflow_runs',
      sourceRef:       r.id,
      sourceLabel:     `Run ${r.id} (${r.workflowId})`,
      priority:        isFailed ? 85 : 70,
      metadata:        { status: r.status, workflowId: r.workflowId, stallMin, traceId: r.traceId },
    })
  }

  return items.slice(0, 6)
}

async function buildRisks(
  db: DbClient, workspaceId: string,
): Promise<BriefingItem[]> {
  const openRisks = await db.select()
    .from(risks)
    .where(and(eq(risks.workspaceId, workspaceId), eq(risks.status, 'open')))
    .orderBy(desc(risks.riskScore))
    .limit(8)

  return openRisks.map((r) => ({
    id:              uuidv7(),
    section:         'risks',
    title:           r.title,
    body:            `${r.description ?? 'No description.'} Probability ${(r.probability * 100).toFixed(0)}%, impact ${(r.impact * 100).toFixed(0)}%. Category: ${r.category}.`,
    confidence:      Math.min(0.95, r.probability * 0.5 + r.impact * 0.5 + 0.30),
    isLowConfidence: r.probability < 0.40 && r.impact < 0.40,
    source:          'risks',
    sourceRef:       r.id,
    sourceLabel:     `Risk: ${r.title}`,
    priority:        Math.round(r.riskScore * 100),
    metadata:        { severity: r.severity, probability: r.probability, impact: r.impact },
  }))
}

async function buildOpportunities(
  db: DbClient, workspaceId: string,
): Promise<BriefingItem[]> {
  const activeOpps = await db.select()
    .from(opportunities)
    .where(and(
      eq(opportunities.workspaceId, workspaceId),
      inArray(opportunities.status, ['identified', 'evaluating', 'active']),
    ))
    .orderBy(desc(opportunities.priority), desc(opportunities.confidence))
    .limit(6)

  return activeOpps.map((o) => ({
    id:              uuidv7(),
    section:         'opportunities',
    title:           o.title,
    body:            `${o.description ?? 'No description.'} Confidence ${(o.confidence * 100).toFixed(0)}%.${o.valuePotential !== null ? ` Est. value: $${o.valuePotential.toLocaleString()}.` : ''} Category: ${o.category}.`,
    confidence:      o.confidence,
    isLowConfidence: o.confidence < LOW_CONF_THRESHOLD,
    source:          'opportunities',
    sourceRef:       o.id,
    sourceLabel:     `Opportunity: ${o.title}`,
    priority:        o.priority,
    metadata:        { status: o.status, category: o.category, valuePotential: o.valuePotential },
  }))
}

async function buildRecoveryItems(
  db: DbClient, workspaceId: string, since: number,
): Promise<BriefingItem[]> {
  const items: BriefingItem[] = []

  // Recent failed runs
  const recentFailures = await db.select({
    id: workflowRuns.id, workflowId: workflowRuns.workflowId,
    errorMessage: workflowRuns.errorMessage, completedAt: workflowRuns.completedAt,
  })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.workspaceId, workspaceId),
      eq(workflowRuns.status, 'failed'),
      gt(workflowRuns.triggeredAt, since),
    ))
    .orderBy(desc(workflowRuns.triggeredAt))
    .limit(5)

  for (const r of recentFailures) {
    items.push({
      id:              uuidv7(),
      section:         'recovery',
      title:           `Recovery needed: ${r.workflowId}`,
      body:            `Run ${r.id} failed: ${r.errorMessage ?? 'unknown error'}. May require manual rollback or replay.`,
      confidence:      0.90,
      isLowConfidence: false,
      source:          'workflow_runs',
      sourceRef:       r.id,
      sourceLabel:     `Failed run: ${r.id}`,
      priority:        80,
      metadata:        { workflowId: r.workflowId, errorMessage: r.errorMessage },
    })
  }

  // Recovery-relevant events (anomalies, SLO breaches)
  const anomalyEvents = await db.select({ id: events.id, type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(
      eq(events.workspaceId, workspaceId),
      inArray(events.type, ['anomaly.detected', 'slo.breached', 'health.check.failed']),
      gt(events.createdAt, since),
    ))
    .orderBy(desc(events.createdAt))
    .limit(4)

  for (const e of anomalyEvents) {
    const p = e.payload as Record<string, unknown>
    items.push({
      id:              uuidv7(),
      section:         'recovery',
      title:           `${e.type}: ${String(p['service'] ?? p['sloName'] ?? 'system')}`,
      body:            `${e.type === 'anomaly.detected' ? `Anomaly: ${String(p['description'] ?? '')}` : e.type === 'slo.breached' ? `SLO breach: ${String(p['sloName'] ?? '')} at ${String(p['current'] ?? '')} vs target ${String(p['target'] ?? '')}` : 'Health check failed'}.`,
      confidence:      0.85,
      isLowConfidence: false,
      source:          'events',
      sourceRef:       e.id,
      sourceLabel:     `Event: ${e.type}`,
      priority:        75,
      metadata:        p,
    })
  }

  return items.slice(0, 8)
}

async function buildNextActions(
  db: DbClient, workspaceId: string, _since: number,
): Promise<BriefingItem[]> {
  const items: BriefingItem[] = []

  // Memory-sourced strategic items
  const strategicMemories = await db.select({
    id: memories.id, content: memories.content, summary: memories.summary,
    confidence: memories.confidence, source: memories.source, tags: memories.tags,
    createdAt: memories.createdAt,
  })
    .from(memories)
    .where(and(
      eq(memories.workspaceId, workspaceId),
      inArray(memories.type, ['goal', 'strategic', 'decision', 'lesson']),
      isNotNull(memories.content),
      sql`(${memories.expiresAt} IS NULL OR ${memories.expiresAt} > ${Date.now()})`,
    ))
    .orderBy(desc(memories.createdAt))
    .limit(5)

  for (const m of strategicMemories) {
    const conf = m.confidence
    items.push({
      id:              uuidv7(),
      section:         'next_actions',
      title:           m.summary ?? m.content.slice(0, 80),
      body:            m.content,
      confidence:      conf,
      isLowConfidence: conf < LOW_CONF_THRESHOLD,
      source:          'memories',
      sourceRef:       m.id,
      sourceLabel:     `Memory (${m.source})`,
      priority:        Math.round(conf * 60 + 20),
      metadata:        { tags: m.tags, memorySource: m.source },
    })
  }

  // High-confidence insights
  const activeInsights = await db.select({
    id: insights.id, title: insights.title, body: insights.body,
    confidence: insights.confidence, source: insights.source, category: insights.category,
  })
    .from(insights)
    .where(and(
      eq(insights.workspaceId, workspaceId),
      eq(insights.dismissed, false),
      eq(insights.actedOn, false),
    ))
    .orderBy(desc(insights.confidence), desc(insights.createdAt))
    .limit(4)

  for (const i of activeInsights) {
    items.push({
      id:              uuidv7(),
      section:         'next_actions',
      title:           i.title,
      body:            i.body,
      confidence:      i.confidence,
      isLowConfidence: i.confidence < LOW_CONF_THRESHOLD,
      source:          'insights',
      sourceRef:       i.id,
      sourceLabel:     `Insight (${i.category})`,
      priority:        Math.round(i.confidence * 50 + 30),
      metadata:        { category: i.category, insightSource: i.source },
    })
  }

  return items.slice(0, 8)
}

// ─── Main generator ───────────────────────────────────────────────────────────

export async function generateBriefing(
  db: DbClient,
  workspaceId: string,
  windowMs = 86_400_000,
): Promise<GeneratedBriefing> {
  const since = Date.now() - windowMs

  const [priorities, blocked, riskItems, oppItems, recoveryItems, nextActions] =
    await Promise.all([
      buildTopPriorities(db, workspaceId, since),
      buildBlockedWorkflows(db, workspaceId, since),
      buildRisks(db, workspaceId),
      buildOpportunities(db, workspaceId),
      buildRecoveryItems(db, workspaceId, since),
      buildNextActions(db, workspaceId, since),
    ])

  const allItems = [
    ...priorities,
    ...blocked,
    ...riskItems,
    ...oppItems,
    ...recoveryItems,
    ...nextActions,
  ]

  const lowConfCount = allItems.filter((i) => i.isLowConfidence).length

  const summary = [
    `${priorities.length} top priorities`,
    `${blocked.length} blocked workflow${blocked.length !== 1 ? 's' : ''}`,
    `${riskItems.length} open risk${riskItems.length !== 1 ? 's' : ''}`,
    `${oppItems.length} opportunit${oppItems.length !== 1 ? 'ies' : 'y'}`,
    `${recoveryItems.length} recovery item${recoveryItems.length !== 1 ? 's' : ''}`,
    `${nextActions.length} next action${nextActions.length !== 1 ? 's' : ''}`,
    lowConfCount > 0 ? `${lowConfCount} low-confidence item${lowConfCount !== 1 ? 's' : ''}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return { summary, items: allItems }
}

// ─── Persist briefing ─────────────────────────────────────────────────────────

export async function persistBriefing(
  db: DbClient,
  briefingId: string,
  workspaceId: string,
  traceId: string,
  requestedBy: string,
  windowMs: number,
  generated: GeneratedBriefing,
): Promise<void> {
  const now = Date.now()

  await db.update(briefings)
    .set({
      status:      'ready',
      summary:     generated.summary,
      generatedAt: now,
    })
    .where(eq(briefings.id, briefingId))

  if (generated.items.length === 0) return

  await db.insert(briefingItems).values(
    generated.items.map((item) => ({
      id:              item.id,
      briefingId,
      workspaceId,
      section:         item.section,
      title:           item.title,
      body:            item.body,
      confidence:      item.confidence,
      isLowConfidence: item.isLowConfidence,
      source:          item.source,
      sourceRef:       item.sourceRef ?? null,
      sourceLabel:     item.sourceLabel ?? null,
      priority:        item.priority,
      metadata:        item.metadata,
      converted:       false,
      createdAt:       now,
    })),
  )
}
