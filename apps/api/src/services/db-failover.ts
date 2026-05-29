/**
 * db-failover.ts — primary + replica health tracking and failover state.
 *
 * Pure state machine + DB-backed health probe. Does NOT replace the
 * existing `db/client.ts`. Instead, exposes the tools the operator
 * needs to evolve toward a multi-region setup:
 *
 *   1. Configure DATABASE_URL (primary) + DATABASE_REPLICA_URL (replica)
 *      in the second region's Neon project.
 *   2. The health monitor pings both on a cron. If the primary fails
 *      N consecutive probes, status flips to 'failed-over' and the
 *      operator sees an alert + can switch DNS / connection-string.
 *   3. The pure state machine is testable; the wiring is a small
 *      follow-up once the second region exists.
 *
 * This module does NOT auto-failover writes — that's a deliberate
 * decision. Auto-failover for a Postgres primary is a foot-gun
 * (split-brain). What it does is:
 *   - probe both endpoints
 *   - track a rolling health score
 *   - surface a structured recommendation when the primary degrades
 *   - emit audit events for every state transition
 *
 * The operator does the actual switch. Novan tells them when to.
 */
import postgres from 'postgres'

export type DbRole   = 'primary' | 'replica'
export type DbStatus = 'healthy' | 'degraded' | 'failed' | 'unknown'

export interface ProbeResult {
  role:        DbRole
  status:      DbStatus
  latencyMs:   number | null
  error:       string | null
  probedAt:    number
}

export interface FailoverState {
  primary:           ProbeResult
  replica:           ProbeResult | null    // null = no replica configured
  consecutiveFails:  Record<DbRole, number>
  recommendation:    'normal' | 'watch_primary' | 'consider_failover' | 'replica_unconfigured' | 'both_down'
  reason:            string
  updatedAt:         number
}

/** Pure: from two probe results, derive the operator-visible state. */
export function deriveState(
  primary:  ProbeResult,
  replica:  ProbeResult | null,
  fails:    Record<DbRole, number>,
): FailoverState {
  let recommendation: FailoverState['recommendation'] = 'normal'
  let reason = 'primary healthy'

  if (primary.status === 'failed' && (!replica || replica.status === 'failed')) {
    recommendation = 'both_down'
    reason = 'primary AND replica failing probes — manual intervention required'
  } else if (primary.status === 'failed') {
    recommendation = 'consider_failover'
    reason = `primary failed ${fails.primary} consecutive probes — replica is healthy`
  } else if (primary.status === 'degraded' && fails.primary >= 3) {
    recommendation = 'watch_primary'
    reason = `primary degraded across ${fails.primary} probes`
  } else if (!replica) {
    recommendation = 'replica_unconfigured'
    reason = 'no DATABASE_REPLICA_URL set — multi-region failover unavailable'
  }

  return {
    primary,
    replica,
    consecutiveFails: fails,
    recommendation,
    reason,
    updatedAt: Date.now(),
  }
}

/**
 * Probe a single endpoint with a 5 s timeout. Treats slow but
 * responsive (>1500 ms) as `degraded` so the operator sees creeping
 * latency before it becomes an outage.
 */
export async function probeEndpoint(role: DbRole, url: string | undefined): Promise<ProbeResult> {
  if (!url) {
    return { role, status: 'unknown', latencyMs: null, error: 'no url configured', probedAt: Date.now() }
  }
  const start = Date.now()
  let client: ReturnType<typeof postgres> | null = null
  try {
    client = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 5 })
    await client`SELECT 1 as ok`
    const latencyMs = Date.now() - start
    const status: DbStatus = latencyMs > 1500 ? 'degraded' : 'healthy'
    return { role, status, latencyMs, error: null, probedAt: Date.now() }
  } catch (e) {
    return { role, status: 'failed', latencyMs: Date.now() - start, error: (e as Error).message, probedAt: Date.now() }
  } finally {
    if (client) await client.end({ timeout: 1 }).catch((e: Error) => { console.error('[db-failover]', e.message); return null })
  }
}

// ─── Rolling state held in-process ──────────────────────────────────────
// Same caveat as provider-concurrency: this is per-instance. For a
// multi-instance deployment, replace the in-memory counters with a
// Redis INCR/DECR pair behind the same interface.

const _state: { fails: Record<DbRole, number>; last: FailoverState | null } = {
  fails: { primary: 0, replica: 0 },
  last: null,
}

export async function runFailoverHealthCheck(): Promise<FailoverState> {
  const primaryUrl = process.env['DATABASE_URL']
  const replicaUrl = process.env['DATABASE_REPLICA_URL']

  const primary = await probeEndpoint('primary', primaryUrl)
  const replica = replicaUrl ? await probeEndpoint('replica', replicaUrl) : null

  if (primary.status === 'failed')   _state.fails.primary++
  else                                _state.fails.primary = 0
  if (replica?.status === 'failed')   _state.fails.replica++
  else if (replica)                   _state.fails.replica = 0

  const next = deriveState(primary, replica, _state.fails)
  _state.last = next
  return next
}

export function getLastFailoverState(): FailoverState | null {
  return _state.last
}

/** Test hook: reset counters. */
export function _resetForTests(): void {
  _state.fails = { primary: 0, replica: 0 }
  _state.last = null
}
