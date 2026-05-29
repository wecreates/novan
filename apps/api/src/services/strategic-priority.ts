/**
 * strategic-priority.ts — "what should I work on next" answer engine.
 *
 * Aggregates open work across five sources and ranks by a TRANSPARENT
 * formula. Every score's components are exposed so the operator can
 * see exactly why something is at the top.
 *
 * Sources:
 *   - issues       (status in [open, triaged, diagnosed])
 *   - ideas        (status in [validated, blueprinted])
 *   - proposals    (status='proposed')
 *   - approvals    (connectorActions phase='awaiting_approval')
 *   - incidents    (status in [open, mitigating])
 *
 * Formula (all weights are constants — no learning, no LLM):
 *   issue.score        = severityWeight × (1 + ageHours/24)
 *   idea.score         = upside × buildReadiness / max(difficulty, 10)
 *   proposal.score     = (riskLevel == high ? 80 : medium ? 50 : 30) + ageHours/12
 *   approval.score     = 60 + ageHours × 5   (older = more urgent)
 *   incident.score     = severityWeight × 1.5 × (1 + ageHours/12)
 *
 * Severity weights:
 *   emergency=100, critical=70, warning=40, info=10
 *
 * Returns ranked list capped at 50, with score breakdown per item.
 */
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  issues, ideas, codeProposals, connectorActions, incidents,
} from '../db/schema.js'

export interface PriorityItem {
  kind:        'issue' | 'idea' | 'proposal' | 'approval' | 'incident'
  id:          string
  title:       string
  score:       number
  /** Formula components — operator sees exactly why this ranked here. */
  scoreParts:  Record<string, number>
  /** Open age in hours for the UI. */
  ageHours:    number
  /** Severity or risk if applicable. */
  severity?:   string
  /** Anchor for "open this" deep link. */
  ref:         { kind: string; id: string }
}

const SEV_WEIGHT: Record<string, number> = {
  emergency: 100, critical: 70, warning: 40, info: 10,
}

function ageHours(ms: number | null): number {
  if (!ms) return 0
  return Math.max(0, (Date.now() - ms) / 3_600_000)
}

export async function rankStrategicPriority(workspaceId: string): Promise<PriorityItem[]> {
  const items: PriorityItem[] = []

  // ── Issues ────────────────────────────────────────────────────────
  const issueRows = await db.select().from(issues)
    .where(and(
      eq(issues.workspaceId, workspaceId),
      inArray(issues.status, ['open', 'triaged', 'diagnosed']),
    ))
    .orderBy(desc(issues.detectedAt))
    .limit(100)
    .catch(() => [])
  for (const i of issueRows) {
    const sevW = SEV_WEIGHT[i.severity] ?? 30
    const age  = ageHours(i.detectedAt)
    const score = sevW * (1 + age / 24)
    items.push({
      kind: 'issue', id: i.id, title: i.symptom.slice(0, 120),
      score, scoreParts: { severityWeight: sevW, ageMultiplier: 1 + age / 24 },
      ageHours: age, severity: i.severity,
      ref: { kind: 'issue', id: i.id },
    })
  }

  // ── Ideas (high-upside, blueprint-ready) ─────────────────────────
  const ideaRows = await db.select().from(ideas)
    .where(and(
      eq(ideas.workspaceId, workspaceId),
      inArray(ideas.status, ['validated', 'blueprinted']),
    ))
    .orderBy(desc(ideas.updatedAt))
    .limit(100)
    .catch(() => [])
  for (const idea of ideaRows) {
    const upside     = idea.upsideScore     ?? 50
    const readiness  = idea.buildReadiness  ?? 50
    const difficulty = idea.difficultyScore ?? 50
    const score = (upside * readiness) / Math.max(difficulty, 10)
    // blueprinted gets a small boost — closer to action
    const boost = idea.status === 'blueprinted' ? 25 : 0
    items.push({
      kind: 'idea', id: idea.id, title: idea.title.slice(0, 120),
      score: score + boost,
      scoreParts: { upside, readiness, difficulty, blueprintedBoost: boost },
      ageHours: ageHours(idea.createdAt),
      ref: { kind: 'idea', id: idea.id },
    })
  }

  // ── Proposals awaiting review ────────────────────────────────────
  const proposalRows = await db.select().from(codeProposals)
    .where(and(
      eq(codeProposals.workspaceId, workspaceId),
      eq(codeProposals.status, 'proposed'),
    ))
    .orderBy(desc(codeProposals.createdAt))
    .limit(50)
    .catch(() => [])
  for (const p of proposalRows) {
    const base = p.riskLevel === 'high' ? 80
              : p.riskLevel === 'medium' ? 50
              : 30
    const age = ageHours(p.createdAt)
    const score = base + age / 12
    items.push({
      kind: 'proposal', id: p.id, title: p.title.slice(0, 120),
      score, scoreParts: { riskBase: base, ageBonus: age / 12 },
      ageHours: age, severity: p.riskLevel,
      ref: { kind: 'proposal', id: p.id },
    })
  }

  // ── Pending approvals ────────────────────────────────────────────
  const approvalRows = await db.select().from(connectorActions)
    .where(and(
      eq(connectorActions.workspaceId, workspaceId),
      eq(connectorActions.phase, 'awaiting_approval'),
    ))
    .orderBy(desc(connectorActions.createdAt))
    .limit(50)
    .catch(() => [])
  for (const a of approvalRows) {
    const age = ageHours(a.createdAt)
    const score = 60 + age * 5
    items.push({
      kind: 'approval', id: a.id, title: `${a.action}: ${a.intent.slice(0, 100)}`,
      score, scoreParts: { baseUrgency: 60, agePenalty: age * 5 },
      ageHours: age, severity: a.riskLevel,
      ref: { kind: 'action', id: a.id },
    })
  }

  // ── Open incidents ───────────────────────────────────────────────
  const incidentRows = await db.select().from(incidents)
    .where(and(
      eq(incidents.workspaceId, workspaceId),
      inArray(incidents.status, ['open', 'acknowledged', 'mitigating', 'escalated']),
    ))
    .orderBy(desc(incidents.detectedAt))
    .limit(50)
    .catch(() => [])
  for (const i of incidentRows) {
    const sevW = SEV_WEIGHT[i.severity] ?? 30
    const age  = ageHours(i.detectedAt)
    const score = sevW * 1.5 * (1 + age / 12)
    items.push({
      kind: 'incident', id: i.id, title: i.title.slice(0, 120),
      score, scoreParts: { severityWeight: sevW, incidentMultiplier: 1.5, ageMultiplier: 1 + age / 12 },
      ageHours: age, severity: i.severity,
      ref: { kind: 'incident', id: i.id },
    })
  }

  // Sort + cap
  items.sort((a, b) => b.score - a.score)
  return items.slice(0, 50)
}
