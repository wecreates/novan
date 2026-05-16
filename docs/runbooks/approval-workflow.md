# Approval Workflow Runbook

## Overview

The approval system provides human oversight for high-risk or policy-gated actions.
Every approval is persisted to Postgres and has a configurable expiry.

## Approval States

```
pending → approved → (action executes)
        → denied   → (action blocked)
        → expired  → (recovery worker scans + marks expired)
```

## Expiry Windows by Risk

| Risk Level | Default Expiry |
|---|---|
| low | 24 hours |
| medium | 8 hours |
| high | 4 hours |
| critical | 2 hours |
| financial | 2 hours |

## API Endpoints

- `POST /api/v1/approvals/:id/approve` — approve an action
- `POST /api/v1/approvals/:id/deny` — deny an action
- `GET  /api/v1/approvals?status=pending` — list pending approvals
- `GET  /api/v1/approvals/:id` — get approval detail

## Recovery Worker

The recovery worker runs `expire-approvals` job every 5 minutes:
- Scans for approvals where `expiresAt < now` and `status = 'pending'`
- Marks them as `expired`
- Emits `approval.expired` event
- The workflow run remains paused — requires manual retry

## Blocked Action Logging

Denied and blocked actions are logged as `action.blocked` events.
They are visible in the event stream and can be replayed if policy is updated.
