/**
 * feedback.ts — Operator-reported issues, confusion, requests, abandonment.
 *
 * Workspace-scoped CRUD. Every report emits a runtime event for visibility.
 */
import { db }                          from '../db/client.js'
import { feedbackReports, events }     from '../db/schema.js'
import { and, desc, eq, sql }          from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export type FeedbackKind   = 'issue' | 'confusion' | 'request' | 'praise' | 'abandoned'
export type FeedbackStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed'

export interface SubmitInput {
  workspaceId: string
  kind:        FeedbackKind
  title:       string
  body?:       string
  surface?:    string
  severity?:   'low' | 'normal' | 'high' | 'critical'
  context?:    Record<string, unknown>
  reportedBy?: string
}

async function emit(workspaceId: string, type: string, payload: Record<string, unknown>) {
  await db.insert(events).values({
    id: uuidv7(), type, workspaceId, payload,
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'feedback', version: 1, createdAt: Date.now(),
  }).catch(() => null)
}

export async function submitFeedback(i: SubmitInput): Promise<string> {
  const id  = uuidv7()
  const now = Date.now()
  await db.insert(feedbackReports).values({
    id, workspaceId: i.workspaceId,
    kind:       i.kind,
    surface:    i.surface  ?? null,
    severity:   i.severity ?? 'normal',
    title:      i.title.slice(0, 300),
    body:       (i.body ?? null) === null ? null : i.body!.slice(0, 5000),
    context:    i.context ?? {},
    status:     'open',
    reportedBy: i.reportedBy ?? null,
    createdAt:  now, updatedAt: now,
  })
  await emit(i.workspaceId, 'feedback.submitted', { id, kind: i.kind, severity: i.severity ?? 'normal' })
  return id
}

export async function listFeedback(workspaceId: string, opts?: { status?: FeedbackStatus; kind?: FeedbackKind; limit?: number }) {
  const conds = [eq(feedbackReports.workspaceId, workspaceId)]
  if (opts?.status) conds.push(eq(feedbackReports.status, opts.status))
  if (opts?.kind)   conds.push(eq(feedbackReports.kind, opts.kind))
  return db.select().from(feedbackReports)
    .where(and(...conds))
    .orderBy(desc(feedbackReports.createdAt))
    .limit(opts?.limit ?? 50)
}

export async function updateStatus(id: string, workspaceId: string, status: FeedbackStatus) {
  await db.update(feedbackReports)
    .set({ status, updatedAt: Date.now() })
    .where(and(eq(feedbackReports.id, id), eq(feedbackReports.workspaceId, workspaceId)))
  await emit(workspaceId, 'feedback.status_changed', { id, status })
}

export async function feedbackSummary(workspaceId: string) {
  const rows = await db.select({
    kind:   feedbackReports.kind,
    status: feedbackReports.status,
    c:      sql<number>`count(*)::int`,
  }).from(feedbackReports)
    .where(eq(feedbackReports.workspaceId, workspaceId))
    .groupBy(feedbackReports.kind, feedbackReports.status)

  const summary = {
    total: 0,
    byKind:   { issue: 0, confusion: 0, request: 0, praise: 0, abandoned: 0 } as Record<FeedbackKind, number>,
    byStatus: { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 } as Record<FeedbackStatus, number>,
  }
  for (const r of rows) {
    const n = Number(r.c)
    summary.total += n
    if (r.kind   in summary.byKind)   summary.byKind[r.kind as FeedbackKind] += n
    if (r.status in summary.byStatus) summary.byStatus[r.status as FeedbackStatus] += n
  }
  return summary
}
