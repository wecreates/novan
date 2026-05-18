/**
 * revenue.ts — Tier-1 closure: revenue side of ROI.
 *
 * Records revenue events from external sources (stripe webhook, manual
 * entry, API). Aggregates per-window, per-workflow attribution where
 * workflow_run_id is populated. Honest about non-attributed revenue.
 */
import { db } from '../db/client.js'
import { revenueEvents } from '../db/schema.js'
import { and, eq, gte, sql, desc } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface RecordRevenueInput {
  workspaceId:   string
  source:        string
  amountUsd:     number
  currency?:     string
  customerRef?:  string
  workflowRunId?: string
  occurredAt?:   number
  metadata?:     Record<string, unknown>
}

export async function recordRevenue(i: RecordRevenueInput): Promise<string> {
  const id = uuidv7()
  await db.insert(revenueEvents).values({
    id, workspaceId: i.workspaceId,
    source: i.source, amountUsd: i.amountUsd,
    currency: i.currency ?? 'USD',
    customerRef:   i.customerRef   ?? null,
    workflowRunId: i.workflowRunId ?? null,
    occurredAt: i.occurredAt ?? Date.now(),
    metadata:   i.metadata   ?? {},
    createdAt:  Date.now(),
  }).catch(() => null)
  return id
}

export async function revenueSummary(workspaceId: string, windowDays = 30) {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select().from(revenueEvents)
    .where(and(eq(revenueEvents.workspaceId, workspaceId), gte(revenueEvents.occurredAt, since)))
    .catch(() => [])
  const total = rows.reduce((s, r) => s + Number(r.amountUsd), 0)
  const attributed = rows.filter(r => r.workflowRunId).reduce((s, r) => s + Number(r.amountUsd), 0)
  const bySource: Record<string, number> = {}
  for (const r of rows) bySource[r.source] = (bySource[r.source] ?? 0) + Number(r.amountUsd)
  return {
    windowDays,
    totalUsd:        Number(total.toFixed(2)),
    attributedUsd:   Number(attributed.toFixed(2)),
    unattributedUsd: Number((total - attributed).toFixed(2)),
    attributionRate: total > 0 ? Number((attributed / total).toFixed(3)) : 0,
    eventCount:      rows.length,
    bySource,
    factType: 'fact' as const,
    source: 'revenue_events.amount_usd',
  }
}

export async function revenueByWorkflow(workspaceId: string, windowDays = 30) {
  const since = Date.now() - windowDays * 24 * 60 * 60_000
  const rows = await db.select({
    workflowRunId: revenueEvents.workflowRunId,
    total:         sql<number>`coalesce(sum(${revenueEvents.amountUsd}), 0)::float`,
    n:             sql<number>`count(*)::int`,
  }).from(revenueEvents)
    .where(and(
      eq(revenueEvents.workspaceId, workspaceId),
      gte(revenueEvents.occurredAt, since),
    ))
    .groupBy(revenueEvents.workflowRunId)
    .catch(() => [])
  return rows
    .filter(r => r.workflowRunId)
    .map(r => ({ workflowRunId: r.workflowRunId!, revenueUsd: Number(Number(r.total).toFixed(2)), events: Number(r.n) }))
    .sort((a, b) => b.revenueUsd - a.revenueUsd)
}

export async function recentRevenue(workspaceId: string, limit = 50) {
  return db.select().from(revenueEvents)
    .where(eq(revenueEvents.workspaceId, workspaceId))
    .orderBy(desc(revenueEvents.occurredAt))
    .limit(limit).catch(() => [])
}
