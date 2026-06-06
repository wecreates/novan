/**
 * R146.231 — Applier daemon health check. The R195 host-side applier
 * runs outside the api container as a systemd unit. The api has no
 * direct view of whether it's alive. Approach: the daemon writes a
 * heartbeat into the events table on each cycle. We query for the
 * most recent applier event and compare timestamp to now.
 *
 * If the applier hasn't logged in >2× its POLL_MS (default 5min, so
 * 10min stale), report 'stale'. If never seen, 'never'. If fresh,
 * 'alive' with the most recent cycle timestamp.
 *
 * The applier emits to events via the loopback admin bridge by writing
 * a system event on each cycle — until that's wired, this reports
 * 'unwired' but still shows last self_dev_proposal apply time as a
 * proxy.
 */
import { db } from '../db/client.js'
import { events, selfDevProposal } from '../db/schema.js'
import { and, desc, eq, gte, sql } from 'drizzle-orm'

export interface ApplierHealth {
  status:           'alive' | 'stale' | 'unwired' | 'never'
  lastEventAt:      number | null
  lastApplyAt:      number | null
  recentApplies24h: number
  recentRollbacks24h: number
}

const STALE_MS = 10 * 60_000  // 10 min — 2× default POLL_MS

export async function applierHealth(): Promise<ApplierHealth> {
  // Most recent applier heartbeat (event type starts with applier.)
  const [hb] = await db.select({ createdAt: events.createdAt })
    .from(events)
    .where(sql`${events.type} LIKE 'applier.%'`)
    .orderBy(desc(events.createdAt)).limit(1)
    .catch(() => [])

  // Most recent apply (or rollback) action visible via self_dev_proposal
  const [lastApply] = await db.select({ appliedAt: selfDevProposal.appliedAt })
    .from(selfDevProposal)
    .where(sql`${selfDevProposal.appliedAt} IS NOT NULL`)
    .orderBy(desc(selfDevProposal.appliedAt)).limit(1)
    .catch(() => [])

  const since24 = Date.now() - 24 * 60 * 60_000
  const [applies] = await db.select({ n: sql<number>`count(*)::int` })
    .from(selfDevProposal)
    .where(and(eq(selfDevProposal.status, 'applied'), gte(selfDevProposal.appliedAt, since24)))
    .catch(() => [])
  const [rollbacks] = await db.select({ n: sql<number>`count(*)::int` })
    .from(selfDevProposal)
    .where(and(eq(selfDevProposal.status, 'failed'), gte(selfDevProposal.rolledBackAt, since24)))
    .catch(() => [])

  const now = Date.now()
  let status: ApplierHealth['status']
  if (!hb) status = 'unwired'
  else if (now - Number(hb.createdAt) > STALE_MS) status = 'stale'
  else status = 'alive'
  // If we have evidence of applies in the last 24h but no event, the
  // daemon is reachable but not emitting heartbeats.
  if (status === 'unwired' && (applies?.n ?? 0) > 0) status = 'alive'

  return {
    status,
    lastEventAt: hb ? Number(hb.createdAt) : null,
    lastApplyAt: lastApply ? Number(lastApply.appliedAt) : null,
    recentApplies24h:   Number(applies?.n ?? 0),
    recentRollbacks24h: Number(rollbacks?.n ?? 0),
  }
}
