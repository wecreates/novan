# Policy Engine Runbook

## Overview
The ops-platform policy engine governs all agent actions using a layered permission model.
Actions must pass policy evaluation before executing.

## Autonomy Levels

| Level | Can Read | Can Recommend | Can Execute (Low Risk) | Can Execute (With Approval) | Can Orchestrate |
|---|---|---|---|---|---|
| `observe_only` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `recommend_only` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `safe_low_risk_automation` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `approval_required_execution` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `restricted_supervised_orchestration` | ✅ | ✅ | ✅ | ✅ | ✅ |

## Policies

### Browser Execution Policy (`policy:browser-execution`)
- **observe_only / recommend_only** → DENY
- **health-check actions** → ALLOW at any execute-capable level
- **Domain allowlisted** → ALLOW at `restricted_supervised_orchestration`
- **All other browser actions** → REQUIRE_APPROVAL

### File Action Policy (`policy:file-action`)
- **Read operations** → always ALLOW
- **Delete operations** → always REQUIRE_APPROVAL
- **Write at `safe_low_risk_automation`** → REQUIRE_APPROVAL
- **Write at `approval_required_execution`+** → ALLOW

### Content Publishing Policy (`policy:content-publishing`)
- **All publishing** → REQUIRE_APPROVAL (always, no exceptions)
- **observe_only / recommend_only** → DENY

### Financial Action Policy (`policy:financial-action`)
- **ALL financial actions** → REQUIRE_APPROVAL (always, no exceptions, critical risk)
- **observe_only / recommend_only** → DENY

### Workflow Execution Policy (`policy:workflow-execution`)
- **observe_only / recommend_only** → DENY
- **Risk-based**: auto-execute only if autonomy level permits the risk level

### Automation Frequency Policy (`policy:automation-frequency`)
- **Default**: 100 actions per hour per workspace
- **> 80% used** → REQUIRE_APPROVAL
- **≥ 100% used** → DENY (rate limit exceeded)

### Provider Usage Policy (`policy:provider-usage`)
- **observe_only** → DENY
- **Provider not allowlisted** → DENY
- **Token budget > 80%** → REQUIRE_APPROVAL
- **Token budget ≥ 100%** → DENY

## Verdict Priority

`deny` > `require_approval` > `allow`

The most restrictive verdict from all applicable policies wins.

## Approval Workflow

1. Policy returns `require_approval`
2. `ApprovalRequestData` is created by the engine
3. Caller persists to `approvals` DB table
4. Event `approval.required` is emitted
5. Human approves/denies via API
6. On approve: `approval.approved` emitted → action proceeds
7. On deny: `approval.denied` emitted → action blocked

## Blocked Action Logging

When verdict = `deny`:
1. `BlockedActionData` is created by the engine
2. Event `action.blocked` is emitted with full context
3. Caller may optionally persist to `dead_letter_jobs` or audit log
4. Action DOES NOT execute

## Events Emitted Per Check

Every policy evaluation emits at minimum:
- `policy.checked` — always

Plus one of:
- `policy.allowed` — verdict = allow
- `approval.required` — verdict = require_approval
- `policy.denied` + `action.blocked` — verdict = deny
