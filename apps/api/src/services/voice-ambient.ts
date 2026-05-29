/**
 * voice-ambient.ts — ambient briefing queue.
 *
 * Novan speaks short updates ONLY for critical events the operator should
 * hear about even when not actively in the voice console:
 *
 *   - incident    : runtime crash, deploy failure
 *   - budget      : budget cap breached / approaching
 *   - approval    : pending approval older than threshold
 *   - agent_failure: agent crashed / DLQ growing
 *   - security    : auth failure burst, suspicious traffic
 *
 * Pure function `scanForBriefings(recentEvents, prefs)` derives the
 * briefing list from a recent slice of `events` rows. Persistence /
 * delivery state lives in `voice_ambient_briefings`.
 *
 * Severity hierarchy: normal < high < critical. The operator's
 * `ambient_severity_floor` filters which kinds are spoken.
 *
 * No constant talking: the same briefing is delivered at most once
 * (matched by `source_event_id`), and the route handler honors a
 * minimum gap between consecutive deliveries.
 */
import { db } from '../db/client.js'
import { events, voiceAmbientBriefings } from '../db/schema.js'
import { and, eq, gte, desc, isNull } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type AmbientKind     = 'incident' | 'budget' | 'approval' | 'agent_failure' | 'security'
export type AmbientSeverity = 'normal' | 'high' | 'critical'

export interface AmbientBriefingInput {
  workspaceId:  string
  kind:         AmbientKind
  severity:     AmbientSeverity
  summary:      string
  sourceEventId?: string
}

/** Strict ordering for severity floor comparisons. */
const SEVERITY_ORDER: Record<AmbientSeverity, number> = { normal: 0, high: 1, critical: 2 }

/** Pure: map an event row to a briefing item, or null when not briefable. */
export function classifyEvent(ev: { type: string; payload: unknown; id: string }, defaultSeverity: AmbientSeverity = 'high'): AmbientBriefingInput | null {
  const t = ev.type
  const p = (ev.payload ?? {}) as { severity?: string; message?: string; summary?: string; reason?: string; task?: string; agent?: string }
  const sev: AmbientSeverity = (p.severity === 'critical' || p.severity === 'high' || p.severity === 'normal')
    ? p.severity as AmbientSeverity
    : defaultSeverity

  // Pattern-match by event type prefix so this stays maintainable.
  if (/(^|\.)incident(\.|$)|^runtime\.error|^deploy\.failed/.test(t)) {
    return { workspaceId: '', kind: 'incident', severity: sev, summary: p.summary ?? p.message ?? `Incident: ${t}`, sourceEventId: ev.id }
  }
  if (/budget\.(?:breach|exceeded|cap_reached)|cron\.failure_threshold/.test(t)) {
    return { workspaceId: '', kind: 'budget', severity: sev, summary: p.summary ?? p.message ?? `Budget alert: ${t}`, sourceEventId: ev.id }
  }
  if (/(^|\.)approval\.(?:pending|escalated|overdue)/.test(t)) {
    return { workspaceId: '', kind: 'approval', severity: sev, summary: p.summary ?? p.message ?? 'Approval needed', sourceEventId: ev.id }
  }
  if (/agent\.(?:crashed|failed|dlq)/.test(t)) {
    return { workspaceId: '', kind: 'agent_failure', severity: sev, summary: p.summary ?? `Agent failure: ${p.agent ?? p.task ?? t}`, sourceEventId: ev.id }
  }
  if (/(^|\.)security\.(?:alert|breach|suspicious)/.test(t)) {
    return { workspaceId: '', kind: 'security', severity: 'critical', summary: p.summary ?? p.message ?? `Security alert: ${t}`, sourceEventId: ev.id }
  }
  return null
}

/** Pure: filter classifications by the operator's severity floor. */
export function aboveFloor(severity: AmbientSeverity, floor: AmbientSeverity): boolean {
  return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[floor]
}

export interface ScanOptions {
  /** Operator's severity floor (default 'critical'). */
  floor?: AmbientSeverity
  /** Already-delivered source event ids — skipped. */
  alreadyDelivered?: ReadonlySet<string>
}

export function scanForBriefings(
  rows: Array<{ id: string; type: string; payload: unknown }>,
  opts: ScanOptions = {},
): AmbientBriefingInput[] {
  const floor = opts.floor ?? 'critical'
  const seen  = opts.alreadyDelivered ?? new Set<string>()
  const out: AmbientBriefingInput[] = []
  for (const r of rows) {
    const cls = classifyEvent(r)
    if (!cls) continue
    if (!aboveFloor(cls.severity, floor)) continue
    if (cls.sourceEventId && seen.has(cls.sourceEventId)) continue
    out.push(cls)
  }
  return out
}

// ─── DB-backed: scan + persist new briefings ────────────────────────────

export async function refreshAmbientBriefings(workspaceId: string, opts: { floor?: AmbientSeverity; windowMs?: number } = {}): Promise<{ created: number }> {
  const since = Date.now() - (opts.windowMs ?? 30 * 60_000)
  const recent = await db.select({ id: events.id, type: events.type, payload: events.payload })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .limit(500).catch(() => [])

  // De-dup against already-created briefings
  const existing = await db.select({ sourceEventId: voiceAmbientBriefings.sourceEventId })
    .from(voiceAmbientBriefings)
    .where(eq(voiceAmbientBriefings.workspaceId, workspaceId))
    .limit(1000).catch(() => [])
  const seen = new Set(existing.map(e => e.sourceEventId).filter((x): x is string => !!x))

  const briefings = scanForBriefings(recent, { ...(opts.floor !== undefined ? { floor: opts.floor } : {}), alreadyDelivered: seen })
  if (briefings.length === 0) return { created: 0 }

  const now = Date.now()
  await db.insert(voiceAmbientBriefings).values(briefings.map(b => ({
    id: uuidv7(),
    workspaceId,
    kind: b.kind, severity: b.severity, summary: b.summary,
    sourceEventId: b.sourceEventId ?? null,
    createdAt: now,
  }))).catch(() => null)
  return { created: briefings.length }
}

export async function pendingBriefings(workspaceId: string, limit = 5) {
  return db.select().from(voiceAmbientBriefings)
    .where(and(eq(voiceAmbientBriefings.workspaceId, workspaceId), isNull(voiceAmbientBriefings.deliveredAt)))
    .orderBy(desc(voiceAmbientBriefings.createdAt))
    .limit(limit).catch(() => [])
}

export async function markDelivered(id: string): Promise<void> {
  await db.update(voiceAmbientBriefings).set({ deliveredAt: Date.now() })
    .where(eq(voiceAmbientBriefings.id, id)).catch(() => null)
}

export async function ackBriefing(id: string): Promise<void> {
  await db.update(voiceAmbientBriefings).set({ ackedAt: Date.now() })
    .where(eq(voiceAmbientBriefings.id, id)).catch(() => null)
}
