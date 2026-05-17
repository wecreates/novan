/**
 * explainability.ts — Why-this-recommendation engine.
 *
 * Given a recommendation id (from recommendation-engine), pull the full
 * evidence chain from real tables:
 *
 *   - source events (recent events with matching IDs)
 *   - influencing incidents
 *   - referenced learning memory (failure_memory, successful_fixes)
 *   - provider metrics
 *   - past patch history (events.type='patch.*' for the affected area)
 *   - rollback availability
 *
 * All evidence is real. Empty chains return empty arrays.
 */
import { db }                          from '../db/client.js'
import {
  events, incidents, failureMemory, successfulFixes,
  providerHealthLog, researchFindings, patchApprovals, roadmapTasks,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { type Recommendation, generateRecommendations } from './recommendation-engine.js'

export interface Explanation {
  recommendationId: string
  recommendation:   Recommendation
  why:              string
  evidenceChain: {
    sourceEvents:        Array<{ id: string; type: string; at: number; payload: unknown }>
    influencingIncidents: Array<{ id: string; title: string; severity: string; status: string; detectedAt: number }>
    learningMemory: {
      failurePatterns:  Array<{ signature: string; occurrences: number; blocked: boolean; lastSeenAt: number | null }>
      successfulFixes:  Array<{ signature: string; description: string; appliedCount: number; lastAppliedAt: number | null }>
    }
    providerMetrics:     Array<{ provider: string; healthy: number; degraded: number; down: number }>
    pastPatchHistory:    Array<{ type: string; count: number; latestAt: number | null }>
    researchReferences:  Array<{ summary: string; sourceUrl: string; confidence: number }>
  }
  /**
   * Composite score 0..1 = impact × confidence. Note: the confidence
   * input comes from the recommendation source (often model-reported,
   * not independently verified). See `confidenceProvenance` for source.
   */
  score:               number
  confidenceProvenance: 'model_reported' | 'heuristic' | 'verified'
  estimatedImpact:     'low' | 'medium' | 'high' | 'critical'
  risks:               string[]
  /**
   * True only if a rollback has actually been performed before on this
   * workspace (proves the path works end-to-end). The rollback engine
   * itself is always available — see `rollbackEngineAvailable`.
   */
  rollbackProven:      boolean
  rollbackEngineAvailable: boolean
  /**
   * Heuristic per-kind template, NOT a model prediction. Operators
   * should treat as a decision aid, not a forecast.
   */
  whatHappensIfIgnored: string
  interpretationType:  'template' | 'model'
}

const WEEK = 7 * 24 * 60 * 60_000

export async function explainRecommendation(workspaceId: string, recommendationId: string): Promise<Explanation | null> {
  // 1. Recompute the recommendation (small cost: same queries as recommendation engine)
  const all = await generateRecommendations(workspaceId)
  const rec = all.find(r => r.id === recommendationId)
  if (!rec) return null

  return assembleExplanation(workspaceId, rec)
}

export async function explainTop(workspaceId: string, limit = 5): Promise<Explanation[]> {
  const all = await generateRecommendations(workspaceId)
  const out: Explanation[] = []
  for (const r of all.slice(0, limit)) {
    out.push(await assembleExplanation(workspaceId, r))
  }
  return out
}

async function assembleExplanation(workspaceId: string, rec: Recommendation): Promise<Explanation> {
  const since = Date.now() - WEEK

  // Extract identifiers from evidence
  const ev = rec.evidence as Record<string, unknown>
  const incidentId = typeof ev['incidentId'] === 'string' ? String(ev['incidentId']) : null
  const approvalId = typeof ev['approvalId'] === 'string' ? String(ev['approvalId']) : null
  const signature  = typeof ev['signature']  === 'string' ? String(ev['signature'])  : null
  const sourceUrl  = typeof ev['sourceUrl']  === 'string' ? String(ev['sourceUrl'])  : null

  const [recentEvents, influencingInc, failMem, successFix, providerMetrics, patchHist, researchRefs] = await Promise.all([
    // recent events that reference the same identifier
    incidentId
      ? db.select({ id: events.id, type: events.type, at: events.createdAt, payload: events.payload }).from(events)
          .where(and(eq(events.workspaceId, workspaceId), sql`${events.payload}::text like ${'%' + incidentId + '%'}`, gte(events.createdAt, since)))
          .orderBy(desc(events.createdAt)).limit(10).catch(() => [])
      : Promise.resolve([] as Array<{ id: string; type: string; at: number; payload: unknown }>),

    incidentId
      ? db.select().from(incidents).where(eq(incidents.id, incidentId)).limit(1).catch(() => [])
      : Promise.resolve([] as Array<{ id: string; title: string; severity: string; status: string; detectedAt: number }>),

    // Related failure memory by signature substring
    signature
      ? db.select().from(failureMemory)
          .where(and(eq(failureMemory.workspaceId, workspaceId), sql`${failureMemory.signature} like ${'%' + signature.slice(0, 40) + '%'}`))
          .orderBy(desc(failureMemory.occurrenceCount)).limit(5).catch(() => [])
      : db.select().from(failureMemory)
          .where(eq(failureMemory.workspaceId, workspaceId))
          .orderBy(desc(failureMemory.occurrenceCount)).limit(3).catch(() => []),

    // Successful fixes (top 3) — always relevant context for "have we fixed similar before"
    db.select().from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .orderBy(desc(successfulFixes.successCount)).limit(3).catch(() => []),

    // Provider metrics (last 7d aggregation)
    db.select({
      provider: providerHealthLog.providerId,
      healthy:  sql<number>`count(*) filter (where ${providerHealthLog.status} = 'healthy')::int`,
      degraded: sql<number>`count(*) filter (where ${providerHealthLog.status} = 'degraded')::int`,
      down:     sql<number>`count(*) filter (where ${providerHealthLog.status} = 'down')::int`,
    }).from(providerHealthLog)
      .where(and(eq(providerHealthLog.workspaceId, workspaceId), gte(providerHealthLog.checkedAt, since)))
      .groupBy(providerHealthLog.providerId)
      .limit(6).catch(() => []),

    // Past patch history — events.type LIKE 'patch.%'
    db.select({
      type: events.type,
      c: sql<number>`count(*)::int`,
      latest: sql<number>`max(${events.createdAt})::bigint`,
    }).from(events)
      .where(and(eq(events.workspaceId, workspaceId), sql`${events.type} like 'patch.%'`, gte(events.createdAt, since)))
      .groupBy(events.type).limit(8).catch(() => []),

    // Research findings if growth/security keyword
    sourceUrl
      ? db.select().from(researchFindings)
          .where(and(eq(researchFindings.workspaceId, workspaceId), eq(researchFindings.sourceUrl, sourceUrl)))
          .limit(1).catch(() => [])
      : Promise.resolve([] as Array<{ summary: string; sourceUrl: string; confidence: number }>),
  ])

  // Risks per kind
  const risks: string[] = []
  if (rec.kind === 'critical_runtime_fix') risks.push('user-visible incident already active')
  if (rec.kind === 'security_risk')        risks.push('exploitation may already be possible')
  if (rec.kind === 'budget_optimization')  risks.push('uncontrolled spend or auto-stop trigger')
  if (rec.kind === 'reliability_improvement') risks.push('recurring failure rate likely to continue')
  if (rec.kind === 'operator_approval')    risks.push('action blocked until approval; downstream work paused')
  if (rec.kind === 'performance_bottleneck') risks.push('latency degradation under load')
  if (rec.kind === 'growth_opportunity')   risks.push('competitive / market window may close')
  if (rec.decision.score < 0.5)       risks.push('low confidence — verify evidence before acting')

  // rollbackProven = rollback path has actually been exercised before
  // (we look for rolled_back events specifically). The engine itself is
  // always available; we surface that separately.
  const rollbackProven = patchHist.some(p => p.type === 'patch.rolled_back')
  const rollbackEngineAvailable = true  // patch-executor.rollbackPatches always exists

  // If-ignored prediction (heuristic, evidence-based)
  let ifIgnored: string
  switch (rec.kind) {
    case 'critical_runtime_fix':  ifIgnored = 'incident remains open; emergency throttle keeps autonomous actions blocked'; break
    case 'reliability_improvement': ifIgnored = 'failure pattern continues; rollback frequency likely to increase'; break
    case 'operator_approval':     ifIgnored = 'patch sits in pending; downstream improvements blocked'; break
    case 'budget_optimization':   ifIgnored = 'hard_stop will trigger when cap reached; AI calls will be blocked'; break
    case 'security_risk':         ifIgnored = 'findings accumulate; risk classification escalates over time'; break
    case 'performance_bottleneck': ifIgnored = 'latency grows; user-facing flows feel slower'; break
    case 'growth_opportunity':    ifIgnored = 'time-bound market signal; usefulness decays'; break
    default:                      ifIgnored = 'state remains as-is'
  }

  return {
    recommendationId: rec.id,
    recommendation:   rec,
    why:              `${rec.kind.replace(/_/g, ' ')} — ${rec.decision.reasons.join('; ')}`,
    evidenceChain: {
      sourceEvents:        recentEvents.map(e => ({ id: e.id, type: e.type, at: Number(e.at), payload: e.payload })),
      influencingIncidents: influencingInc.map(i => ({
        id: i.id, title: String(i.title ?? ''), severity: String(i.severity ?? ''),
        status: String(i.status ?? ''), detectedAt: Number(i.detectedAt ?? 0),
      })),
      learningMemory: {
        failurePatterns: failMem.map(f => ({
          signature: String(f.signature ?? ''),
          occurrences: Number(f.occurrenceCount ?? 0),
          blocked: !!f.blocked,
          lastSeenAt: f.lastSeenAt ? Number(f.lastSeenAt) : null,
        })),
        successfulFixes: successFix.map(s => ({
          signature:   String(s.failureSignature ?? ''),
          description: String(s.fixDescription ?? ''),
          appliedCount: Number(s.successCount ?? 0),
          lastAppliedAt: s.lastAppliedAt ? Number(s.lastAppliedAt) : null,
        })),
      },
      providerMetrics: providerMetrics.map(p => ({
        provider: String(p.provider),
        healthy:  Number(p.healthy ?? 0),
        degraded: Number(p.degraded ?? 0),
        down:     Number(p.down ?? 0),
      })),
      pastPatchHistory: patchHist.map(p => ({ type: p.type, count: Number(p.c), latestAt: p.latest ? Number(p.latest) : null })),
      researchReferences: researchRefs.map(r => ({
        summary: String(r.summary ?? '').slice(0, 200),
        sourceUrl: String(r.sourceUrl ?? ''),
        confidence: Number(r.confidence ?? 0),
      })),
    },
    score:                rec.decision.score,
    // Research findings come from Groq's self-reported confidence;
    // approvals/incidents are heuristic; nothing is verified yet.
    confidenceProvenance: rec.kind === 'growth_opportunity' ? 'model_reported' : 'heuristic',
    estimatedImpact:      rec.estimatedImpact,
    risks,
    rollbackProven,
    rollbackEngineAvailable,
    whatHappensIfIgnored: ifIgnored,
    interpretationType:   'template',
  }
}

// ─── Unified confidence surfaces ─────────────────────────────────────────────

/** Per-domain confidence summary — surfaces what confidence numbers exist anywhere. */
export async function confidenceSurfaces(workspaceId: string) {
  const since = Date.now() - WEEK
  const [research, approvals, roadmap, fixes] = await Promise.all([
    db.select({
      avg: sql<number>`coalesce(avg(${researchFindings.confidence}), 0)::float`,
      n: sql<number>`count(*)::int`,
    }).from(researchFindings)
      .where(and(eq(researchFindings.workspaceId, workspaceId), gte(researchFindings.createdAt, since)))
      .then(r => r[0] ?? { avg: 0, n: 0 }).catch(() => ({ avg: 0, n: 0 })),
    db.select({
      pending: sql<number>`count(*) filter (where ${patchApprovals.status} = 'pending')::int`,
      approved: sql<number>`count(*) filter (where ${patchApprovals.status} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${patchApprovals.status} = 'rejected')::int`,
    }).from(patchApprovals)
      .where(eq(patchApprovals.workspaceId, workspaceId))
      .then(r => r[0] ?? { pending: 0, approved: 0, rejected: 0 }).catch(() => ({ pending: 0, approved: 0, rejected: 0 })),
    db.select({
      avgScore: sql<number>`coalesce(avg(${roadmapTasks.priorityScore}), 0)::float`,
      n: sql<number>`count(*)::int`,
    }).from(roadmapTasks)
      .where(eq(roadmapTasks.workspaceId, workspaceId))
      .then(r => r[0] ?? { avgScore: 0, n: 0 }).catch(() => ({ avgScore: 0, n: 0 })),
    db.select({
      total: sql<number>`coalesce(sum(${successfulFixes.successCount}), 0)::int`,
      patterns: sql<number>`count(*)::int`,
    }).from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .then(r => r[0] ?? { total: 0, patterns: 0 }).catch(() => ({ total: 0, patterns: 0 })),
  ])
  // Approval-rate confidence: higher when more approved vs rejected
  const decided = Number(approvals.approved) + Number(approvals.rejected)
  const approvalRate = decided > 0 ? Number(approvals.approved) / decided : null

  // Structured as three explicit groups with their own scales — operators
  // should NOT compare numbers across groups (research is 0..1, roadmap
  // priority is roughly 0..100, fixes are raw counts).
  return {
    confidence_0_to_1: {
      label: 'Numbers on a 0..1 confidence scale (NOT comparable to priority/count groups below)',
      research: {
        avgConfidence: Number(Number(research.avg ?? 0).toFixed(2)),
        sampleSize:    Number(research.n),
        provenance:    'model_reported_by_groq',
        caveat:        'Groq scores its own output — treat as model-reported confidence, not verified ground truth.',
      },
      approvals: {
        approvalRate, // 0..1, null if no decisions yet
        pending:  Number(approvals.pending),
        approved: Number(approvals.approved),
        rejected: Number(approvals.rejected),
        provenance: 'human_decisions',
      },
    },
    priority_scores: {
      label: 'Roadmap priority scores — internal heuristic, roughly 0..100',
      roadmap: {
        avgPriorityScore: Number(Number(roadmap.avgScore ?? 0).toFixed(1)),
        sampleSize:       Number(roadmap.n),
        scale:            '0..100',
      },
    },
    counts: {
      label: 'Raw integer counts',
      fixes: {
        totalApplied:     Number(fixes.total),
        distinctPatterns: Number(fixes.patterns),
      },
    },
  }
}
