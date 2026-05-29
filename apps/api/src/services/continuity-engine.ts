/**
 * continuity-engine.ts — Long-term operational memory aggregator.
 *
 * Surfaces "what does Novan remember about this operator" in one query
 * envelope. Pure SELECTs against real tables; no fakes.
 *
 *   - previous incidents       (incidents)
 *   - previous fixes           (successful_fixes)
 *   - previous failures        (failure_memory)
 *   - operator decisions       (patch_approvals + feedback_reports)
 *   - unresolved risks         (audit_findings + open incidents)
 *   - recurring bottlenecks    (failure_memory.occurrence_count >= 3)
 *   - lessons learned          (successful_fixes filtered by recency)
 */
import { db }                          from '../db/client.js'
import {
  incidents, successfulFixes, failureMemory, patchApprovals,
  feedbackReports, auditFindings,
} from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'

const DAY = 24 * 60 * 60_000

export interface ContinuitySnapshot {
  workspaceId:           string
  capturedAt:            number
  previousIncidents:     Array<{ id: string; title: string; severity: string; status: string; detectedAt: number; ageDays: number }>
  previousFixes:         Array<{ signature: string; description: string; appliedCount: number; lastAppliedAt: number | null }>
  previousFailures:      Array<{ signature: string; type: string; occurrences: number; blocked: boolean; lastSeenAt: number | null }>
  operatorDecisions: {
    patchApprovals: { approved: number; rejected: number; pending: number; approvalRate: number | null }
    feedbackByKind: Record<string, number>
  }
  unresolvedRisks:       Array<{ source: 'incident' | 'audit_finding'; id: string; title: string; severity: string; ageDays: number }>
  recurringBottlenecks:  Array<{ signature: string; type: string; occurrences: number }>
  lessonsLearned:        Array<{ pattern: string; fix: string; provenAppliedCount: number }>
}

export async function snapshot(workspaceId: string): Promise<ContinuitySnapshot> {
  const now = Date.now()
  const ageDays = (ts: number | null | undefined) => ts ? Math.floor((now - ts) / DAY) : 0

  const [pastInc, fixes, failures, approvals, feedback, openInc, secAudit, recurring] = await Promise.all([
    db.select().from(incidents)
      .where(eq(incidents.workspaceId, workspaceId))
      .orderBy(desc(incidents.detectedAt)).limit(20).catch(() => []),

    db.select().from(successfulFixes)
      .where(eq(successfulFixes.workspaceId, workspaceId))
      .orderBy(desc(successfulFixes.successCount)).limit(20).catch(() => []),

    db.select().from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.lastSeenAt)).limit(20).catch(() => []),

    db.select({
      approved: sql<number>`count(*) filter (where ${patchApprovals.status} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${patchApprovals.status} = 'rejected')::int`,
      pending:  sql<number>`count(*) filter (where ${patchApprovals.status} = 'pending')::int`,
    }).from(patchApprovals)
      .where(eq(patchApprovals.workspaceId, workspaceId))
      .then(r => r[0] ?? { approved: 0, rejected: 0, pending: 0 }).catch(() => ({ approved: 0, rejected: 0, pending: 0 })),

    db.select({ kind: feedbackReports.kind, c: sql<number>`count(*)::int` }).from(feedbackReports)
      .where(eq(feedbackReports.workspaceId, workspaceId))
      .groupBy(feedbackReports.kind).catch(() => []),

    db.select().from(incidents)
      .where(and(eq(incidents.workspaceId, workspaceId), eq(incidents.status, 'open')))
      .orderBy(desc(incidents.detectedAt)).limit(10).catch(() => []),

    db.select().from(auditFindings)
      .where(and(eq(auditFindings.workspaceId, workspaceId), eq(auditFindings.category, 'security')))
      .orderBy(desc(auditFindings.createdAt)).limit(10).catch(() => []),

    db.select().from(failureMemory)
      .where(eq(failureMemory.workspaceId, workspaceId))
      .orderBy(desc(failureMemory.occurrenceCount))
      .then(rs => rs.filter(r => Number(r.occurrenceCount) >= 3))
      .catch(() => []),
  ])

  const decided = Number(approvals.approved) + Number(approvals.rejected)
  const approvalRate = decided > 0 ? Number(approvals.approved) / decided : null

  const feedbackByKind: Record<string, number> = {}
  for (const f of feedback) feedbackByKind[String(f.kind)] = Number(f.c)

  return {
    workspaceId, capturedAt: now,
    previousIncidents: pastInc.map(i => ({
      id: i.id, title: String(i.title ?? ''),
      severity: String(i.severity ?? ''), status: String(i.status ?? ''),
      detectedAt: Number(i.detectedAt ?? 0),
      ageDays: ageDays(Number(i.detectedAt ?? 0)),
    })),
    previousFixes: fixes.map(f => ({
      signature: String(f.failureSignature ?? ''),
      description: String(f.fixDescription ?? ''),
      appliedCount: Number(f.successCount ?? 0),
      lastAppliedAt: f.lastAppliedAt ? Number(f.lastAppliedAt) : null,
    })),
    previousFailures: failures.map(f => ({
      signature: String(f.signature ?? ''),
      type: String(f.failureType ?? ''),
      occurrences: Number(f.occurrenceCount ?? 0),
      blocked: !!f.blocked,
      lastSeenAt: f.lastSeenAt ? Number(f.lastSeenAt) : null,
    })),
    operatorDecisions: {
      patchApprovals: {
        approved: Number(approvals.approved), rejected: Number(approvals.rejected),
        pending: Number(approvals.pending),
        approvalRate: approvalRate !== null ? Number(approvalRate.toFixed(3)) : null,
      },
      feedbackByKind,
    },
    unresolvedRisks: [
      ...openInc.map(i => ({
        source: 'incident' as const, id: i.id,
        title: String(i.title ?? ''), severity: String(i.severity ?? ''),
        ageDays: ageDays(Number(i.detectedAt ?? 0)),
      })),
      ...secAudit.map(a => ({
        source: 'audit_finding' as const, id: a.id,
        title: String(a.description ?? '').slice(0, 120), severity: String(a.severity ?? ''),
        ageDays: ageDays(Number(a.createdAt ?? 0)),
      })),
    ].sort((a, b) => b.ageDays - a.ageDays).slice(0, 12),
    recurringBottlenecks: recurring.slice(0, 8).map(f => ({
      signature: String(f.signature ?? ''),
      type: String(f.failureType ?? ''),
      occurrences: Number(f.occurrenceCount ?? 0),
    })),
    lessonsLearned: fixes.slice(0, 10).map(f => ({
      pattern: String(f.failureSignature ?? '').slice(0, 160),
      fix: String(f.fixDescription ?? '').slice(0, 240),
      provenAppliedCount: Number(f.successCount ?? 0),
    })),
  }
}

/**
 * Match a current signature against past successful fixes — used by the
 * recommendation engine for context-aware scoring.
 * Returns the best matching past fix (substring match on signature).
 */
export async function findPastFix(workspaceId: string, currentSignature: string): Promise<{ signature: string; description: string; appliedCount: number } | null> {
  const probe = currentSignature.slice(0, 40)
  if (probe.length < 8) return null
  const row = await db.select().from(successfulFixes)
    .where(and(
      eq(successfulFixes.workspaceId, workspaceId),
      sql`${successfulFixes.failureSignature} like ${'%' + probe + '%'}`,
    ))
    .orderBy(desc(successfulFixes.successCount))
    .limit(1).then(r => r[0]).catch((e: Error) => { console.error('[continuity-engine]', e.message); return null })
  if (!row) return null
  return {
    signature: String(row.failureSignature ?? ''),
    description: String(row.fixDescription ?? ''),
    appliedCount: Number(row.successCount ?? 0),
  }
}
