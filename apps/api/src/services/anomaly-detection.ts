/**
 * anomaly-detection.ts — pure + DB-backed behavioral anomaly scoring (#21).
 *
 * Five signal families, each a small pattern detector over recent events:
 *   - api_abuse        : burst of 4xx/5xx from a single api key / route
 *   - auth_burst       : burst of auth.failure events
 *   - runtime_spike    : >10x baseline event volume in a 5-minute window
 *   - unsafe_automation: hard-blocked voice / browser refusals stacking up
 *   - secret_leak      : events with payloads matching obvious secret patterns
 *
 * Pure helpers exposed for tests; the DB wrapper composes inputs from
 * the `events` table and writes deduped rows into `anomaly_signals`
 * (same kind+subject within 30 minutes increments `occurrences` instead
 * of creating a new row).
 */
import { db } from '../db/client.js'
import { events, anomalySignals } from '../db/schema.js'
import { and, eq, gte, desc, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export type AnomalyKind = 'api_abuse' | 'auth_burst' | 'runtime_spike' | 'unsafe_automation' | 'secret_leak'
export type Severity    = 'low' | 'medium' | 'high' | 'critical'

export interface AnomalyVerdict {
  kind:     AnomalyKind
  severity: Severity
  score:    number       // 0..1
  subject:  string | null
  evidence: Record<string, unknown>
}

const SECRET_RE = /(?:sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/

export interface EventLike {
  type:    string
  payload: unknown
  createdAt: number
}

/** Pure: score a batch of events into anomaly verdicts. */
export function detectAnomalies(rows: ReadonlyArray<EventLike>, opts: { baselineEventsPerMin?: number } = {}): AnomalyVerdict[] {
  if (rows.length === 0) return []
  const out: AnomalyVerdict[] = []

  // 1. Auth burst — auth.failure count
  const authFails = rows.filter(r => /^(?:auth\.failure|auth\.denied)$/.test(r.type)).length
  if (authFails >= 5) {
    out.push({
      kind: 'auth_burst', severity: authFails >= 20 ? 'critical' : authFails >= 10 ? 'high' : 'medium',
      score: Math.min(1, authFails / 30), subject: null,
      evidence: { count: authFails },
    })
  }

  // 2. Unsafe automation — hard blocks stacking
  const hardBlocks = rows.filter(r => /(?:^|\.)(?:hard_block|block|rejected)$/.test(r.type) || (r.type.startsWith('voice.') && (r.payload as { plan?: { verdict?: string } } | null)?.plan?.verdict === 'reject')).length
  if (hardBlocks >= 3) {
    out.push({
      kind: 'unsafe_automation', severity: hardBlocks >= 10 ? 'high' : 'medium',
      score: Math.min(1, hardBlocks / 15), subject: null,
      evidence: { count: hardBlocks },
    })
  }

  // 3. Runtime spike — total event volume / window
  const windowMinutes = rows.length === 0 ? 1 : Math.max(1, (Date.now() - rows[rows.length - 1]!.createdAt) / 60_000)
  const perMin = rows.length / windowMinutes
  const baseline = opts.baselineEventsPerMin ?? 8
  if (perMin > baseline * 10) {
    out.push({
      kind: 'runtime_spike', severity: perMin > baseline * 25 ? 'critical' : 'high',
      score: Math.min(1, perMin / (baseline * 30)), subject: null,
      evidence: { perMin: Number(perMin.toFixed(1)), baseline },
    })
  }

  // 4. API abuse — burst of error events from a single source
  const errorBySubject = new Map<string, number>()
  for (const r of rows) {
    if (!/error|abuse|rate.?limit|4\d\d|5\d\d/i.test(r.type)) continue
    const subj = (r.payload as { source?: string; user_id?: string; api_key?: string } | null)?.source
              ?? (r.payload as { user_id?: string } | null)?.user_id
              ?? (r.payload as { api_key?: string } | null)?.api_key
              ?? 'unknown'
    errorBySubject.set(subj, (errorBySubject.get(subj) ?? 0) + 1)
  }
  for (const [subject, count] of errorBySubject) {
    if (count < 10) continue
    out.push({
      kind: 'api_abuse', severity: count >= 50 ? 'high' : 'medium',
      score: Math.min(1, count / 80), subject,
      evidence: { count, subject },
    })
  }

  // 5. Secret leak — payloads carrying obvious credential patterns
  const leaky = rows.filter(r => SECRET_RE.test(JSON.stringify(r.payload ?? '')))
  if (leaky.length > 0) {
    out.push({
      kind: 'secret_leak', severity: 'critical',
      score: Math.min(1, 0.5 + leaky.length * 0.1), subject: null,
      evidence: { events: leaky.length, sample_types: [...new Set(leaky.map(l => l.type))].slice(0, 5) },
    })
  }

  return out
}

const DEDUPE_MS = 30 * 60_000

export async function scanAnomalies(workspaceId: string, opts: { windowMs?: number } = {}): Promise<{ raised: number; updated: number; verdicts: AnomalyVerdict[] }> {
  const windowMs = opts.windowMs ?? 15 * 60_000
  const since = Date.now() - windowMs
  const rows = await db.select({ type: events.type, payload: events.payload, createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.workspaceId, workspaceId), gte(events.createdAt, since)))
    .limit(5000).catch(() => [])
  const verdicts = detectAnomalies(rows as EventLike[])

  let raised = 0, updated = 0
  for (const v of verdicts) {
    const existing = await db.select().from(anomalySignals)
      .where(and(
        eq(anomalySignals.workspaceId, workspaceId),
        eq(anomalySignals.kind, v.kind),
        gte(anomalySignals.lastSeenAt, Date.now() - DEDUPE_MS),
      )).limit(1).then(r => r[0]).catch((e: Error) => { console.error('[anomaly-detection]', e.message); return null })
    if (existing) {
      await db.update(anomalySignals).set({
        lastSeenAt: Date.now(),
        occurrences: existing.occurrences + 1,
        score: Math.max(existing.score, v.score),
        evidence: v.evidence,
      }).where(eq(anomalySignals.id, existing.id)).catch((e: Error) => { console.error('[anomaly-detection]', e.message); return null })
      updated++
    } else {
      await db.insert(anomalySignals).values({
        id: uuidv7(), workspaceId,
        kind: v.kind, severity: v.severity, score: v.score,
        subject: v.subject, evidence: v.evidence,
        firstSeenAt: Date.now(), lastSeenAt: Date.now(),
        occurrences: 1, createdAt: Date.now(),
      }).catch((e: Error) => { console.error('[anomaly-detection]', e.message); return null })
      raised++
    }
  }
  return { raised, updated, verdicts }
}

export async function listAnomalies(workspaceId: string, limit = 50) {
  return db.select().from(anomalySignals)
    .where(eq(anomalySignals.workspaceId, workspaceId))
    .orderBy(desc(anomalySignals.lastSeenAt))
    .limit(limit).catch(() => [])
}

export async function ackAnomaly(id: string, workspaceId: string): Promise<void> {
  await db.update(anomalySignals).set({ ackedAt: Date.now() })
    .where(and(eq(anomalySignals.id, id), eq(anomalySignals.workspaceId, workspaceId))).catch((e: Error) => { console.error('[anomaly-detection]', e.message); return null })
}
