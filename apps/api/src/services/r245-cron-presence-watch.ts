/**
 * R146.245 — Cron presence watchdog. Detects critical crons that
 * haven't fired their expected heartbeat in the last 2× their interval
 * and opens an issue. The R193 inspector creates findings but only
 * over a 6h window and gated by self_dev_inspect_enabled. This is
 * always-on and more aggressive — surfaces real outage signal fast.
 */
import { db } from '../db/client.js'
import { events, issues } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

interface ExpectedCron {
  eventType:  string
  maxAgeMs:   number  // expected interval × 2
  severity:   'high' | 'medium' | 'low'
}

const EXPECTED: ExpectedCron[] = [
  { eventType: 'cron.radar_scan',                maxAgeMs: 20 * 60_000, severity: 'medium' }, // 10min interval × 2
  { eventType: 'cron.proactive_scan',            maxAgeMs: 20 * 60_000, severity: 'medium' },
  // R146.269 — these two emit `cron.<name>_tick` unconditionally each
  // run (and the un-suffixed event only when there's work or the 23h
  // heartbeat fires). Watch the _tick variants for proof of life.
  { eventType: 'cron.session_sync_prune_tick',   maxAgeMs: 2 * 60 * 60_000, severity: 'low' },
  { eventType: 'cron.approved_reply_send_tick',  maxAgeMs: 2 * 60 * 60_000, severity: 'low' },
  { eventType: 'cron.incident_scan_completed',   maxAgeMs: 20 * 60_000, severity: 'high' },
  { eventType: 'cron.platform_smoke_completed',  maxAgeMs: 2 * 60 * 60_000, severity: 'medium' },
  { eventType: 'cron.frontier_consumer_tick',    maxAgeMs: 10 * 60_000, severity: 'low' },
  { eventType: 'applier.cycle',                  maxAgeMs: 15 * 60_000, severity: 'medium' },
  // R146.256 — R255 brain-alert tick emits a heartbeat every run so the
  // watchdog can see it even when nothing changed.
  { eventType: 'cron.brain_alert_heartbeat',     maxAgeMs: 45 * 60_000, severity: 'low' },
]

export interface PresenceResult {
  missing: Array<{ eventType: string; lastSeenAt: number | null; ageMs: number | null; severity: string }>
  issuesOpened: number
}

export async function checkCronPresence(): Promise<PresenceResult & { autoClosed: number }> {
  const now = Date.now()
  // R146.270 — boot grace: if a cron has never emitted but the process
  // has been up less than its maxAgeMs, treat it as still warming, not
  // missing. Avoids the post-redeploy "8 missing" flap.
  const uptimeMs = process.uptime() * 1000
  const missing: PresenceResult['missing'] = []
  let opened = 0
  let autoClosed = 0

  for (const exp of EXPECTED) {
    const [latest] = await db.select({ createdAt: events.createdAt })
      .from(events)
      .where(eq(events.type, exp.eventType))
      .orderBy(desc(events.createdAt))
      .limit(1)
      .catch(() => [])
    const lastSeenAt = latest?.createdAt ? Number(latest.createdAt) : null
    const ageMs = lastSeenAt === null ? null : now - lastSeenAt
    // Never-seen + boot-grace → still warming, skip.
    const inBootGrace = lastSeenAt === null && uptimeMs < exp.maxAgeMs
    const isMissing = !inBootGrace && (lastSeenAt === null || ageMs! > exp.maxAgeMs)

    const fingerprint = `cron-presence:${exp.eventType}`
    if (!isMissing) {
      // R146.246 — recovery: auto-close any open issue with the
      // matching fingerprint. Avoids the operator wading through
      // stale alerts after the cron starts firing again.
      const [openIssue] = await db.select({ id: issues.id })
        .from(issues)
        .where(and(
          eq(issues.fingerprint, fingerprint),
          eq(issues.status, 'open'),
        ))
        .limit(1)
        .catch(() => [])
      if (openIssue) {
        await db.update(issues).set({ status: 'closed', updatedAt: now })
          .where(eq(issues.id, openIssue.id)).catch(() => null)
        autoClosed++
      }
      continue
    }
    missing.push({ eventType: exp.eventType, lastSeenAt, ageMs, severity: exp.severity })

    // Open issue if not already open for this cron in the last 2h.
    const since = now - 2 * 60 * 60_000
    const [existing] = await db.select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.workspaceId, 'global'),
        eq(issues.source, 'cron-presence-watch'),
        eq(issues.status, 'open'),
        sql`${issues.symptom} LIKE ${'%' + exp.eventType + '%'}`,
        gte(issues.createdAt, since),
      ))
      .limit(1)
      .catch(() => [])
    if (existing) continue

    const symptom = lastSeenAt === null
      ? `cron ${exp.eventType} has never fired`
      : `cron ${exp.eventType} hasn't fired in ${Math.round((ageMs || 0) / 60_000)}min (expected ≤${exp.maxAgeMs / 60_000}min)`
    await db.insert(issues).values({
      id: uuidv7(), workspaceId: 'global',
      severity: exp.severity === 'high' ? 'critical' : exp.severity === 'medium' ? 'warning' : 'info',
      status: 'open',
      source: 'cron-presence-watch',
      symptom, fingerprint,
      detectedAt: now,
      createdAt: now, updatedAt: now,
    }).catch(() => null)
    opened++
  }

  return { missing, issuesOpened: opened, autoClosed }
}
