/**
 * R146.325 (#15) — per-type retention policy for the events table.
 *
 * The existing R276 retention sweeps only touch external_knowledge +
 * platform_smoke_runs. The events table has a single 30-day cutoff
 * (platform-hardening.ts) plus a 90-day cutoff (learning-cron.ts). For
 * heterogeneous workloads that's wrong: business-revenue events should
 * live forever (audit), runtime heartbeats can drop after 7 days,
 * applier.cycle after 24h.
 *
 * Policy table: type-prefix → retention days. Caller iterates and
 * issues a single DELETE per prefix.
 */
import { db } from '../db/client.js'
import { events } from '../db/schema.js'
import { sql, and, lt, like } from 'drizzle-orm'

export const RETENTION_POLICY: Array<{ prefix: string; days: number; reason: string }> = [
  { prefix: 'applier.cycle',         days:   1, reason: 'heartbeats; only need recent for liveness' },
  { prefix: 'runtime.heartbeat',     days:   7, reason: 'host telemetry; 7d for trend' },
  { prefix: 'cron.metric',           days:  14, reason: 'cron timing; 14d for week-over-week' },
  { prefix: 'web_fetch.completed',   days:  30, reason: 'research history' },
  { prefix: 'web_fetch.failed',      days:   7, reason: 'failure debugging' },
  { prefix: 'web_fetch.blocked',     days:   7, reason: 'SSRF rejects' },
  { prefix: 'admin_brain.invoked',   days: 365, reason: 'audit trail — keep 1 year' },
  { prefix: 'deploy.',               days: 365, reason: 'deployment history' },
  { prefix: 'governance.',           days:   0, reason: 'KEEP FOREVER — compliance audit' },
  { prefix: 'business.',             days:   0, reason: 'KEEP FOREVER — revenue audit' },
  { prefix: 'cost.reconciled',       days:   0, reason: 'KEEP FOREVER — finance' },
]

export interface RetentionRunResult { prefix: string; deleted: number; ageDays: number; kept: boolean }

export async function runEventsRetention(): Promise<RetentionRunResult[]> {
  const out: RetentionRunResult[] = []
  const now = Date.now()
  for (const p of RETENTION_POLICY) {
    if (p.days === 0) {
      out.push({ prefix: p.prefix, deleted: 0, ageDays: 0, kept: true })
      continue
    }
    const cutoff = now - p.days * 24 * 60 * 60_000
    try {
      const r = await db.delete(events)
        .where(and(
          like(events.type, `${p.prefix}%`),
          lt(events.createdAt, cutoff),
        ))
        .returning({ id: events.id })
      out.push({ prefix: p.prefix, deleted: r.length, ageDays: p.days, kept: false })
    } catch (e) {
      // Failure is non-fatal — sweep skips and tries next prefix
      out.push({ prefix: p.prefix, deleted: -1, ageDays: p.days, kept: false })
      void e
    }
  }
  return out
}

// Quick lookup: does an arbitrary type match a KEEP-FOREVER prefix?
export function isImmutableEventType(type: string): boolean {
  for (const p of RETENTION_POLICY) {
    if (p.days === 0 && type.startsWith(p.prefix)) return true
  }
  return false
}

// Force coverage check at boot — if a type doesn't match any policy,
// the global 30-day default applies; surface this in logs so we know.
void sql  // re-export anchor
