/**
 * recommendation-engine.ts — Unified priority queue across all signal sources.
 *
 * Pulls real evidence from runtime tables and assembles a single ranked
 * list of recommendations. Every recommendation includes:
 *   - source: where the signal came from
 *   - evidence: the row IDs / counts that justified it
 *   - bucket: P0 | P1 | P2 | P3
 *   - autoApplyOk: whether the prioritizer allows auto-apply
 *
 * No fakes. Empty inputs → empty output.
 */
import { db }                          from '../db/client.js'
import {
  incidents, auditFindings, patchApprovals, roadmapTasks,
  failureMemory, providerBudgets, workflowRuns, researchFindings,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { prioritize, type PriorityInput, type PriorityDecision } from './agent-coordinator.js'

export type RecKind =
  | 'critical_runtime_fix'
  | 'reliability_improvement'
  | 'operator_approval'
  | 'budget_optimization'
  | 'security_risk'
  | 'performance_bottleneck'
  | 'growth_opportunity'

export interface Recommendation {
  id:           string             // stable per signal source + key
  kind:         RecKind
  title:        string
  evidence:     Record<string, unknown>
  decision:     PriorityDecision
  estimatedImpact: 'low' | 'medium' | 'high' | 'critical'
}

const DAY = 24 * 60 * 60_000

// 30s response cache — explainRecommendation otherwise re-runs the full
// query graph on every call. Bypassed in test env so mocks stay authoritative.
const REC_CACHE = new Map<string, { value: Recommendation[]; expiresAt: number }>()
const REC_CACHE_TTL_MS = 30_000

export function invalidateRecommendationCache(workspaceId?: string): void {
  if (workspaceId) REC_CACHE.delete(workspaceId)
  else REC_CACHE.clear()
}

export async function generateRecommendations(workspaceId: string, opts?: { forceRefresh?: boolean }): Promise<Recommendation[]> {
  const useCache = process.env['NODE_ENV'] !== 'test' && !opts?.forceRefresh
  if (useCache) {
    const cached = REC_CACHE.get(workspaceId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
  }
  const result = await generateRecommendationsImpl(workspaceId)
  if (useCache) REC_CACHE.set(workspaceId, { value: result, expiresAt: Date.now() + REC_CACHE_TTL_MS })
  return result
}

async function generateRecommendationsImpl(workspaceId: string): Promise<Recommendation[]> {
  const since = Date.now() - 7 * DAY
  const recs: Recommendation[] = []

  const [
    openCritIncidents, openOtherIncidents,
    secAudit, perfAudit, reliAudit,
    pendingApprovals, budgetRow, failedWorkflows,
    recurringFailures, growthInsights,
  ] = await Promise.all([
    db.select({
      id: incidents.id, title: incidents.title, severity: incidents.severity,
    }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open'), eq(incidents.severity, 'critical')))
      .limit(5).catch(() => []),

    db.select({
      id: incidents.id, title: incidents.title, severity: incidents.severity,
    }).from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .limit(10).catch(() => []),

    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), sql`${auditFindings.category} in ('performance','optimization')`))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),
    db.select({ c: sql<number>`count(*)::int` }).from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), sql`${auditFindings.category} in ('reliability','runtime')`))
      .then(r => Number(r[0]?.c ?? 0)).catch(() => 0),

    db.select({
      id: patchApprovals.id, riskReason: patchApprovals.riskReason, riskLevel: patchApprovals.riskLevel,
    }).from(patchApprovals)
      .where(and(eq(patchApprovals.workspaceId, workspaceId), eq(patchApprovals.status, 'pending')))
      .limit(10).catch(() => []),

    db.select().from(providerBudgets)
      .where(eq(providerBudgets.workspaceId, workspaceId)).limit(1).then(r => r[0]).catch(() => null),

    db.select({
      id: workflowRuns.id, errorMessage: workflowRuns.errorMessage,
    }).from(workflowRuns)
      .where(and(eq(workflowRuns.workspaceId, workspaceId), eq(workflowRuns.status, 'failed'), gte(workflowRuns.failedAt, since)))
      .orderBy(desc(workflowRuns.failedAt)).limit(10).catch(() => []),

    db.select({
      signature: failureMemory.signature, occurrences: failureMemory.occurrenceCount,
    }).from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount)).limit(5)
      .then(rs => rs.filter(r => Number(r.occurrences) >= 3)).catch(() => []),

    db.select({
      summary: researchFindings.summary, confidence: researchFindings.confidence, sourceUrl: researchFindings.sourceUrl,
    }).from(researchFindings)
      .where(and(
        eq(researchFindings.workspaceId, workspaceId),
        gte(researchFindings.createdAt, since),
        sql`${researchFindings.factType} = 'fact' AND ${researchFindings.confidence} >= 0.7`,
        sql`(${researchFindings.summary} ilike '%competitor%' OR ${researchFindings.summary} ilike '%market%' OR ${researchFindings.summary} ilike '%adoption%' OR ${researchFindings.summary} ilike '%pricing%')`,
      ))
      .orderBy(desc(researchFindings.confidence)).limit(3).catch(() => []),
  ])

  // ─── Critical runtime fixes (open critical incidents) ──────────────────────
  for (const i of openCritIncidents) {
    const input: PriorityInput = {
      productionImpact: 1.0, reliabilityImpact: 1.0, securityImpact: 0.6, costImpact: 0.4, confidence: 1.0,
    }
    recs.push({
      id: `incident:${i.id}`, kind: 'critical_runtime_fix',
      title: `Resolve critical incident: ${i.title}`,
      evidence: { incidentId: i.id, severity: i.severity },
      decision: prioritize(`incident:${i.id}`, input),
      estimatedImpact: 'critical',
    })
  }

  // ─── Reliability (non-critical open incidents + reliability audit cluster) ─
  for (const i of openOtherIncidents.filter(x => x.severity !== 'critical')) {
    const input: PriorityInput = {
      productionImpact: 0.7, reliabilityImpact: 0.9, securityImpact: 0.3, costImpact: 0.3, confidence: 0.9,
    }
    recs.push({
      id: `incident:${i.id}`, kind: 'reliability_improvement',
      title: `Resolve incident: ${i.title}`,
      evidence: { incidentId: i.id, severity: i.severity },
      decision: prioritize(`incident:${i.id}`, input),
      estimatedImpact: 'high',
    })
  }
  if (reliAudit > 0) {
    const input: PriorityInput = {
      productionImpact: 0.5, reliabilityImpact: 0.7, securityImpact: 0.2, costImpact: 0.2, confidence: 0.7,
    }
    recs.push({
      id: 'audit:reliability', kind: 'reliability_improvement',
      title: `Triage ${reliAudit} reliability audit findings`,
      evidence: { count: reliAudit },
      decision: prioritize('audit:reliability', input),
      estimatedImpact: reliAudit >= 20 ? 'high' : 'medium',
    })
  }
  for (const f of recurringFailures) {
    const input: PriorityInput = {
      productionImpact: 0.6, reliabilityImpact: 0.9, securityImpact: 0.2, costImpact: 0.3, confidence: 0.95,
    }
    recs.push({
      id: `failure:${f.signature.slice(0, 32)}`, kind: 'reliability_improvement',
      title: `Recurring failure (${f.occurrences}x): ${String(f.signature).slice(0, 100)}`,
      evidence: { signature: f.signature, occurrences: f.occurrences },
      decision: prioritize(`failure:${f.signature}`, input),
      estimatedImpact: Number(f.occurrences) >= 10 ? 'critical' : 'high',
    })
  }

  // ─── Operator approvals ────────────────────────────────────────────────────
  for (const p of pendingApprovals) {
    const isHigh = p.riskLevel === 'high' || p.riskLevel === 'critical'
    const input: PriorityInput = {
      productionImpact: isHigh ? 0.8 : 0.4, reliabilityImpact: 0.5,
      securityImpact: isHigh ? 0.7 : 0.3, costImpact: 0.2, confidence: 1.0,
    }
    recs.push({
      id: `approval:${p.id}`, kind: 'operator_approval',
      title: `Pending ${p.riskLevel} approval: ${String(p.riskReason).slice(0, 100)}`,
      evidence: { approvalId: p.id, riskLevel: p.riskLevel },
      decision: prioritize(`approval:${p.id}`, input),
      estimatedImpact: isHigh ? 'high' : 'medium',
    })
  }

  // ─── Budget ────────────────────────────────────────────────────────────────
  if (budgetRow) {
    const dailyPct  = budgetRow.dailyLimitUsd > 0 ? budgetRow.dailySpendUsd  / budgetRow.dailyLimitUsd  : 0
    const monthlyPct = budgetRow.monthlyLimitUsd > 0 ? budgetRow.monthlySpendUsd / budgetRow.monthlyLimitUsd : 0
    if (dailyPct >= budgetRow.alertThreshold || monthlyPct >= budgetRow.alertThreshold) {
      const input: PriorityInput = {
        productionImpact: 0.4, reliabilityImpact: 0.4, securityImpact: 0.1, costImpact: 1.0, confidence: 1.0,
      }
      recs.push({
        id: 'budget:approaching_cap', kind: 'budget_optimization',
        title: `Budget at ${Math.round(Math.max(dailyPct, monthlyPct) * 100)}% of cap`,
        evidence: { dailyPct: Number(dailyPct.toFixed(3)), monthlyPct: Number(monthlyPct.toFixed(3)) },
        decision: prioritize('budget:cap', input),
        estimatedImpact: Math.max(dailyPct, monthlyPct) >= 0.95 ? 'critical' : 'high',
      })
    }
  }

  // ─── Security ──────────────────────────────────────────────────────────────
  if (secAudit > 0) {
    const input: PriorityInput = {
      productionImpact: 0.5, reliabilityImpact: 0.3, securityImpact: 1.0, costImpact: 0.2, confidence: 0.8,
    }
    recs.push({
      id: 'audit:security', kind: 'security_risk',
      title: `Review ${secAudit} security audit findings`,
      evidence: { count: secAudit },
      decision: prioritize('audit:security', input),
      estimatedImpact: secAudit >= 5 ? 'critical' : 'high',
    })
  }

  // ─── Performance ───────────────────────────────────────────────────────────
  if (perfAudit > 0) {
    const input: PriorityInput = {
      productionImpact: 0.5, reliabilityImpact: 0.6, securityImpact: 0.1, costImpact: 0.5, confidence: 0.7,
    }
    recs.push({
      id: 'audit:performance', kind: 'performance_bottleneck',
      title: `Address ${perfAudit} performance findings`,
      evidence: { count: perfAudit },
      decision: prioritize('audit:performance', input),
      estimatedImpact: perfAudit >= 10 ? 'high' : 'medium',
    })
  }

  // ─── Failed workflows ──────────────────────────────────────────────────────
  if (failedWorkflows.length >= 3) {
    const input: PriorityInput = {
      productionImpact: 0.7, reliabilityImpact: 0.9, securityImpact: 0.1, costImpact: 0.4, confidence: 0.9,
    }
    recs.push({
      id: 'workflows:failed_cluster', kind: 'reliability_improvement',
      title: `${failedWorkflows.length} workflow failures in last 7 days`,
      evidence: { runIds: failedWorkflows.map(w => w.id).slice(0, 5) },
      decision: prioritize('workflows:failed', input),
      estimatedImpact: failedWorkflows.length >= 10 ? 'high' : 'medium',
    })
  }

  // ─── Growth opportunities (from research findings) ─────────────────────────
  for (const g of growthInsights) {
    const input: PriorityInput = {
      productionImpact: 0.2, reliabilityImpact: 0.1, securityImpact: 0.0, costImpact: 0.4, confidence: Number(g.confidence),
    }
    recs.push({
      id: `growth:${(g.sourceUrl ?? '').slice(0, 60)}`, kind: 'growth_opportunity',
      title: `Growth insight: ${String(g.summary).slice(0, 100)}`,
      evidence: { sourceUrl: g.sourceUrl, confidence: g.confidence },
      decision: prioritize(`growth:${g.sourceUrl}`, input),
      estimatedImpact: 'medium',
    })
  }

  // Sort by score desc
  recs.sort((a, b) => b.decision.score - a.decision.score)
  return recs
}

export async function topRecommendations(workspaceId: string, limit = 10): Promise<Recommendation[]> {
  const all = await generateRecommendations(workspaceId)
  return all.slice(0, limit)
}
