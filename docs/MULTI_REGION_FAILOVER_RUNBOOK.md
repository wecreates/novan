# Multi-region failover runbook

This is the operator-facing recipe for going from single-region to
multi-region resilience. The code primitives are already shipped in
`services/db-failover.ts`. What's required from you is provisioning
the second region and setting two env vars.

## Why this is deliberately operator-driven

Auto-failover for a Postgres primary is a foot-gun. Split-brain
scenarios (two primaries accepting writes after a network partition)
corrupt data permanently. Novan's failover system:

- Probes both endpoints continuously.
- Emits an audit event (`runtime.failover.alert`) the moment the
  recommendation transitions.
- Surfaces a structured recommendation in the Strategic Console.
- **Does not auto-switch writes.** The operator does the switch.

This is the directive `#52` constitution rule in action: no
self-authorized risky behavior.

## What ships in code

- `services/db-failover.ts`
  - `runFailoverHealthCheck()` — probes primary + replica with 5 s
    timeouts. Latency > 1500 ms is `degraded`. Failure is `failed`.
  - `deriveState(primary, replica, fails)` — pure state machine.
  - Recommendations: `normal` · `watch_primary` · `consider_failover`
    · `replica_unconfigured` · `both_down`.
- Cron registered in `learning-cron.ts` at 1-hour cadence. Emits an
  alert only on recommendation transitions.
- Routes:
  - `GET /api/v1/intel-ops/failover/health` — probe now, return state.
  - `GET /api/v1/intel-ops/failover/state` — last cached probe.

## Setup steps

### 1. Provision the secondary region

In the Neon dashboard:

1. Create a new project in your secondary region (e.g. if primary is
   `us-east-2`, choose `us-west-2` or `eu-west-1`).
2. Enable logical replication on the primary.
3. Configure the secondary as a replica of the primary. Neon's docs:
   [logical replication](https://neon.tech/docs/guides/logical-replication-guide).
4. Confirm replication lag is < 5 seconds in the dashboard before
   proceeding.

### 2. Set the env var

In your deployment environment:

```bash
DATABASE_URL=postgres://...primary-region.neon.tech/...
DATABASE_REPLICA_URL=postgres://...secondary-region.neon.tech/...
```

Restart the API. Within 1 hour, the failover probe cron will detect
the replica and emit `runtime.failover.alert` with
`recommendation: 'normal'` and `replica: { status: 'healthy', ... }`.

### 3. Mirror Upstash (optional but recommended)

Upstash Redis supports global replication on the paid tier. Enable
it on the queue/cache instances so a regional Neon outage doesn't
also take queues offline.

### 4. Verify

```bash
curl /api/v1/intel-ops/failover/health
```

Expected response:

```json
{
  "success": true,
  "data": {
    "primary": { "role": "primary", "status": "healthy", "latencyMs": 42, ... },
    "replica": { "role": "replica", "status": "healthy", "latencyMs": 61, ... },
    "recommendation": "normal",
    "reason": "primary healthy"
  }
}
```

## When the operator gets a failover alert

If the cron emits `recommendation: 'consider_failover'`:

1. **Verify the replica is up to date.** In the Neon dashboard, check
   replication lag. Anything under 30 seconds is recoverable.
2. **Promote the replica to primary** in the Neon dashboard.
3. **Swap the env vars.** The new primary's URL becomes
   `DATABASE_URL`; the demoted primary (if still reachable) becomes
   `DATABASE_REPLICA_URL`. Restart the API.
4. **Audit the gap.** Any writes between the last replication moment
   and the promotion are lost. Check the audit log
   (`events.createdAt > lastReplicationTs`) to identify them.

If the alert is `both_down`: this is a regional cloud outage. Page the
operator on call and wait for the provider's status page. There is
nothing to switch to.

## Honest limits

- **No automatic write redirection.** This is intentional.
- **No cross-region read load balancing.** All reads go to the
  primary today. Splitting reads is a future addition once the
  replica is proven healthy in production.
- **Replication lag is not tracked here.** Neon dashboard or a custom
  `pg_stat_replication` query is the canonical source.
- **The probe is per-API-instance.** A multi-instance deployment
  needs all instances to agree; today the recommendation reflects
  whatever instance the cron lands on.

## What this closes from the audit

| Tier 1 gap | Status |
|---|---|
| No multi-region failover | **Code primitives + observability shipped. Provisioning is operator work.** |
