# Strategic War Room — Operator Help

Quick reference for every War Room page.

## Status Vocabulary

| Status            | Meaning |
|-------------------|---------|
| `open`            | Incident / approval is unattended |
| `acknowledged`    | Human has accepted ownership |
| `mitigating`      | Active repair in progress |
| `resolved`        | Incident closed with resolution note |
| `escalated`       | Severity raised; usually requires manual ops action |
| `running`         | Job / sandbox / assignment actively executing |
| `complete`        | Finished successfully |
| `failed`          | Finished with non-zero exit |
| `timeout`         | Killed for exceeding time limit |
| `blocked`         | Waiting for dependencies or approval |
| `cancelled`       | Cancelled by operator |
| `isolation_violation` | Sandbox/orchestrator rule rejected this execution |

## Common Operator Tasks

### Pause Agents
**Where**: War Room → Agents → Agent Control
**How**: `POST /api/v1/agents/:id/pause` (button in UI). Pauses outbound work; in-flight jobs continue until their natural completion.

### Approve Risky Patches
**Where**: War Room → Patch Approvals
**How**:
1. Audit dispatches risky tasks via `POST /audit/runs/:id/tasks/:taskId/dispatch`
2. If `risk_classifier` flags it, a `patch_approvals` row is created
3. Reviewer opens approval card → reads risk reason + affected files
4. **Approve** (optional note), **Reject** (note required), or **Request Changes** (note required)
5. Approval unblocks the task — agent may now dispatch via the same endpoint

### Use Kill Switches
**Where**: War Room → Cost Governor → Kill Switches (`/governor/kill-switches`)
**How**: Each kill switch maps to a category (AI calls, deploys, schedules, etc.). Toggle enabled state via API. While enabled, all matching operations are denied at entry. Use during budget runaway or provider outage.

### Recover Stuck Jobs
**Where**: War Room → Orchestrator → Locks tab
**How**:
1. Click **Sweep stale** — calls `POST /api/v1/orchestrator/locks/recover`
2. Stale locks (TTL expired) get marked released
3. Stuck assignments (>10 min running) get auto-failed by `failStuckAssignments`
4. If a workflow specifically is stuck, mark its assignment complete: `POST /api/v1/orchestrator/assignments/:id/complete` with `success=false`

### Verify Launch Readiness
**Where**: War Room → Launch Lock (`/launch-lock`)
**How**:
1. Click **Run Audit** — executes all 14 checks
2. Review score + per-check results
3. Failed/unverified critical checks block launch
4. If a launch is needed despite blockers: **Apply Admin Override** with a 5+ char reason (1h TTL by default)
5. Override is logged in `events` table (type `launch.override_applied`) and visible in audit history

## Pages by Function

| Page              | Purpose | API |
|-------------------|---------|-----|
| War Room          | Live overview | `/api/v1/stream` |
| Timeline          | Event history | `/api/v1/events` |
| Goals / Risks     | Strategic planning | `/api/v1/goals`, `/api/v1/risks` |
| Agents            | Agent registry | `/api/v1/agents` |
| Memory Browser    | Semantic memory | `/api/v1/memory` |
| Workflows         | Workflow defs + runs | `/api/v1/workflows`, `/api/v1/workflow-runs` |
| Dead Letter       | Failed job replay | `/api/v1/dead-letter` |
| Approvals         | Workflow approvals | `/api/v1/approvals` |
| Patch Approvals   | Risky patch review | `/api/v1/patch-approvals` |
| Analytics         | Usage metrics | `/api/v1/analytics` |
| Insights          | AI insights | `/api/v1/insights` |
| Learning Center   | Learning runtime | `/api/v1/learning` |
| Learning Runtime  | Failure memory + fixes | `/api/v1/learning-runtime` |
| Remote Compute    | Provider & worker status | `/api/v1/cloud-runtime`, `/api/v1/ai-router` |
| Cost Governor     | Budgets + alerts + kill switches | `/api/v1/governor` |
| Audit             | Full-repo audit | `/api/v1/audit` |
| Sandbox           | Isolated execution sessions | `/api/v1/sandbox` |
| Incidents         | Production incidents | `/api/v1/incidents` |
| Orchestrator      | Multi-agent assignments + locks | `/api/v1/orchestrator` |
| Launch Lock       | Production readiness | `/api/v1/production-readiness` |

## Secret Safety

Never paste raw API keys, passwords, or tokens into:
- Approval notes
- Incident resolution notes
- Override reasons
- Any text field in the UI

Sandbox executor + secret-redactor.ts automatically scrub known patterns (OpenAI, Anthropic, AWS, GitHub, Stripe, JWT, env-secrets) from persisted output, but operator inputs are not redacted at write time.

## When in Doubt

1. Check `events` table via Timeline page — every state change emits an event
2. Check the relevant runbook in `docs/runbooks.md`
3. Escalate via Incident → Escalate action with a clear reason
