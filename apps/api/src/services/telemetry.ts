/**
 * telemetry.ts — Lightweight product-event capture + aggregation.
 *
 * No hidden telemetry: every call is workspace-scoped and persists to
 * telemetry_events. Aggregations are pure SELECTs computed on demand.
 */
import { db }                          from '../db/client.js'
import { telemetryEvents }             from '../db/schema.js'
import { and, desc, eq, gte, sql }     from 'drizzle-orm'
import { v7 as uuidv7 }                from 'uuid'

export type TelemetryCategory = 'feature_use' | 'friction' | 'completion' | 'abandonment' | 'approval'
export type TelemetryOutcome  = 'success' | 'failure' | 'cancelled' | 'blocked'

export interface TrackInput {
  workspaceId: string
  category:    TelemetryCategory
  name:        string
  surface?:    string
  outcome?:    TelemetryOutcome
  durationMs?: number
  attributes?: Record<string, unknown>
}

export async function track(i: TrackInput): Promise<void> {
  await db.insert(telemetryEvents).values({
    id:          uuidv7(),
    workspaceId: i.workspaceId,
    category:    i.category,
    name:        i.name,
    surface:     i.surface     ?? null,
    outcome:     i.outcome     ?? null,
    durationMs:  i.durationMs  ?? null,
    attributes:  i.attributes  ?? {},
    createdAt:   Date.now(),
  }).catch(() => null)
}

// ─── Aggregations ────────────────────────────────────────────────────────────

export async function topFeatures(workspaceId: string, windowMs = 7 * 24 * 60 * 60_000, limit = 10) {
  const since = Date.now() - windowMs
  return db.select({
    name:  telemetryEvents.name,
    count: sql<number>`count(*)::int`,
    successRate: sql<number>`coalesce(avg(case when ${telemetryEvents.outcome} = 'success' then 1.0 else 0.0 end), 0)::float`,
  }).from(telemetryEvents)
    .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, since)))
    .groupBy(telemetryEvents.name)
    .orderBy(desc(sql`count(*)`))
    .limit(limit)
}

export async function frictionEvents(workspaceId: string, windowMs = 7 * 24 * 60 * 60_000, limit = 20) {
  const since = Date.now() - windowMs
  return db.select().from(telemetryEvents)
    .where(and(
      eq(telemetryEvents.workspaceId, workspaceId),
      eq(telemetryEvents.category, 'friction'),
      gte(telemetryEvents.createdAt, since),
    ))
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit)
}

export async function failureRates(workspaceId: string, windowMs = 24 * 60 * 60_000) {
  const since = Date.now() - windowMs
  return db.select({
    name:  telemetryEvents.name,
    total: sql<number>`count(*)::int`,
    failures: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'failure')::int`,
    blocked: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'blocked')::int`,
    cancelled: sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'cancelled')::int`,
    avgDurationMs: sql<number>`coalesce(avg(${telemetryEvents.durationMs}), 0)::float`,
  }).from(telemetryEvents)
    .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, since)))
    .groupBy(telemetryEvents.name)
    .orderBy(desc(sql`count(*) filter (where ${telemetryEvents.outcome} = 'failure')`))
    .limit(20)
}

export async function sessionSummary(workspaceId: string, windowMs = 24 * 60 * 60_000) {
  const since = Date.now() - windowMs
  const totals = await db.select({
    total:        sql<number>`count(*)::int`,
    distinctNames: sql<number>`count(distinct ${telemetryEvents.name})::int`,
    failures:     sql<number>`count(*) filter (where ${telemetryEvents.outcome} = 'failure')::int`,
    abandonments: sql<number>`count(*) filter (where ${telemetryEvents.category} = 'abandonment')::int`,
    completions:  sql<number>`count(*) filter (where ${telemetryEvents.category} = 'completion')::int`,
  }).from(telemetryEvents)
    .where(and(eq(telemetryEvents.workspaceId, workspaceId), gte(telemetryEvents.createdAt, since)))
    .then(r => r[0])

  return {
    windowMs,
    total:         Number(totals?.total ?? 0),
    distinctNames: Number(totals?.distinctNames ?? 0),
    failures:      Number(totals?.failures ?? 0),
    abandonments:  Number(totals?.abandonments ?? 0),
    completions:   Number(totals?.completions ?? 0),
    failureRate:   Number(totals?.total ?? 0) === 0 ? 0 : Number(totals?.failures ?? 0) / Number(totals?.total),
  }
}
