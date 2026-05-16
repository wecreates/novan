# Operator Runbooks

Each runbook lists: detection signal → severity → immediate action → rollback → verification → escalation.

---

## 1. Provider Outage

**Detection**: War Room → Incidents shows `provider_outage`. Or `GET /api/v1/incidents/scan` returns candidate. Or `provider_health_log.status=down`.
**Severity**: warning (degraded) / critical (down).
**Immediate action**:
1. Open War Room → Compute → Provider Health
2. Confirm failing provider
3. POST `/api/v1/incidents/:id/acknowledge`
4. If failover provider available, route traffic via ai-router config
**Rollback**: Re-enable original provider once health log shows recovery.
**Verification**: New `provider_health_log` row with status=healthy.
**Escalate**: All providers down → escalate incident (`POST /:id/escalate`), enable kill switch for AI features.

---

## 2. Worker Crash

**Detection**: `agent_registrations.status=down` (heartbeat > 60s stale) or sandbox sessions with expired lease.
**Severity**: warning (1) / critical (≥3 stuck sessions).
**Immediate action**:
1. War Room → Orchestrator → Agents tab
2. Identify down agents
3. POST `/api/v1/orchestrator/agents/:id/restart`
4. Sweep stale locks: POST `/api/v1/orchestrator/locks/recover`
**Rollback**: Locks auto-released by stale-lock recovery. Any in-flight assignments auto-fail after 10 min.
**Verification**: Heartbeat refreshes; status returns to `idle` or `busy`.
**Escalate**: Restart fails repeatedly → check worker process logs; investigate OOM/crash loop.

---

## 3. Queue Backlog

**Detection**: `dead_letter_jobs` count ≥ 20 per queue (incident detector).
**Severity**: info (20-50), warning (50-100), critical (≥100).
**Immediate action**:
1. War Room → Dead Letter
2. Inspect failure pattern (group by jobName)
3. If systematic — fix root cause first
4. Replay in batches via `POST /api/v1/dead-letter/:id/replay`
**Rollback**: Replayed jobs that fail again return to DLQ — safe to retry.
**Verification**: DLQ count decreasing, replay logs show success.
**Escalate**: Workers can't process even after replay → scale workers or fix code.

---

## 4. Budget Spike

**Detection**: `budget_alerts` with `dismissed=false` at ≥75% threshold.
**Severity**: info (75%), warning (80-90%), critical (≥90%).
**Immediate action**:
1. War Room → Cost Governor
2. Identify alert type (daily/weekly/monthly/per-job)
3. Review recent expensive jobs (Cost Dashboard)
4. If runaway: enable kill switch via `POST /api/v1/governor/kill-switches/:id/enable`
**Rollback**: Disable kill switch when usage normalises.
**Verification**: Spend rate drops; new period rolls over without re-firing alert.
**Escalate**: Budget intentionally needs raising → update budget config; do not silently dismiss alert.

---

## 5. Failed Deployment

**Detection**: Build/test verification evidence with `passed=false` in last hour.
**Severity**: critical (blocks launch).
**Immediate action**:
1. War Room → Audit (last run) → identify failing check
2. Inspect evidence rows (`verification_evidence` table)
3. Patch root cause via Audit task dispatch
4. Re-run audit
**Rollback**: Already-deployed code unaffected — failed deploy did not promote.
**Verification**: New `verification_evidence` row with `passed=true` for tsc/eslint/tests/build.
**Escalate**: Repair loop (multiple rollback failures) → see Runbook 7.

---

## 6. Replay Divergence

**Detection**: Same job/command shows both pass and fail in `verification_evidence` (incident type `replay_divergence`).
**Severity**: warning.
**Immediate action**:
1. War Room → Incidents → expand the divergence incident
2. Identify if flaky test or environment drift
3. If flaky test — mark and exclude, file ticket
4. If environment drift — compare worker env vars (sandbox executor enforces allowlist, so drift should be limited)
**Rollback**: Not applicable — replay divergence is a signal, not a state change.
**Verification**: Re-run job 3x in same sandbox; if consistent, divergence resolved.
**Escalate**: Divergence pattern persists → escalate to test-stability owner.

---

## 7. Rollback Failure

**Detection**: Incident type `rollback_failure` — ≥2 rollbacks on same job in 1h.
**Severity**: critical.
**Immediate action**:
1. **HALT auto-repair**: incident-triage marks this `requires_approval=true`
2. War Room → Incidents → escalate (`POST /:id/escalate`)
3. Lock affected files: `POST /api/v1/orchestrator/assignments` with `lock_requests` for each file
4. Inspect `patch_records.rollback_reason` per file
**Rollback**: Roll back to last known-good commit if needed (git-level, outside platform).
**Verification**: Files locked, no new patch attempts visible in War Room → Orchestrator.
**Escalate**: Always — rollback failure means auto-repair is diverging; humans must own this.

---

## 8. Stuck Workflow

**Detection**: `workflow_runs.status=running` with no progress > 10 min. Or `agent_assignments.status=running` past `STUCK_ASSIGNMENT_MS` (10 min).
**Severity**: warning.
**Immediate action**:
1. War Room → Timeline (find latest event for the workflow)
2. War Room → Orchestrator → Assignments
3. If assignment exists — wait for auto-fail (10 min) or POST `/api/v1/orchestrator/assignments/:id/complete` with `success=false`
4. If no assignment — investigate workflow worker (BullMQ status)
**Rollback**: Workflow stays at last checkpoint; restart triggers from there.
**Verification**: New `workflow_runs` event with status update.
**Escalate**: Multiple stuck workflows on same worker → restart that worker.

---

## 9. API Key / Provider Failure

**Detection**: `provider_failures` rows with auth-related error. Or `provider_health_log.status=down` with high error rate.
**Severity**: critical.
**Immediate action**:
1. War Room → Compute → Provider Health
2. **DO NOT** put new keys into chat or UI — see Secret Safety
3. Restart API server with corrected env var (out-of-band, ops shell)
4. Confirm `provider_health_log` shows recovery within 5 min
**Rollback**: Re-enable failover provider.
**Verification**: New successful provider call in `provider_failures` absent for 5 min window.
**Escalate**: Provider account-level issue (rate limit, billing) → contact provider support.

---

## 10. Cloud-API-Only Misconfiguration

**Detection**: No `sandbox_sessions` succeeding; all returning `isolation_violation` or env-related failures.
**Severity**: high.
**Immediate action**:
1. War Room → Sandbox
2. Inspect violation reasons (sandbox events with `eventType=isolation_violation`)
3. Common: command not on allowlist, working dir outside `REPO_ROOT`
4. Update `ALLOWED_COMMANDS` or `SANDBOX_ENV_ALLOWLIST` in `secret-redactor.ts` if intentional
**Rollback**: Revert config change; sandbox sessions retry.
**Verification**: New `sandbox_sessions.status=complete` row.
**Escalate**: Sandbox impossible in this environment → switch to remote workers via cloud-runtime.

---

## Incident Severity Reference

| Severity   | Response time | Auto-repair | Approval |
|------------|---------------|-------------|----------|
| info       | next business day | yes (safe types) | no |
| warning    | within 1h     | yes (safe types) | no |
| critical   | within 15min  | type-dependent   | usually |
| emergency  | immediate     | NEVER auto       | always   |
