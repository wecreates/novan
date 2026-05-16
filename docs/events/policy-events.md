# Policy Engine Events

All policy engine events are emitted via the event bus and persisted to the `events` table.

## Event Reference

### `policy.checked`
Emitted on every policy evaluation.

```json
{
  "workspaceId": "ws-abc",
  "action": "browser.navigate",
  "policyId": "policy:browser-execution",
  "policyName": "Browser Execution Policy",
  "verdict": "require_approval",
  "riskLevel": "high",
  "agentId": "agent-xyz",
  "traceId": "trace-123",
  "timestamp": 1700000000000
}
```

### `policy.allowed`
Action was permitted by policy.

### `policy.denied`
Action was blocked by policy. Includes `reason` and `riskLevel`.

### `approval.required`
A human approval request was created.

```json
{
  "workspaceId": "ws-abc",
  "action": "financial.transfer",
  "policyId": "policy:financial-action",
  "riskLevel": "critical",
  "operationLabel": "Financial: transfer $500",
  "agentId": "agent-xyz",
  "traceId": "trace-123",
  "timestamp": 1700000000000
}
```

### `approval.approved`
A human approved the action. The action may now proceed.

### `approval.denied`
A human denied the action. The action is permanently blocked.

### `action.blocked`
An action was blocked (either by policy denial or approval denial).
This event persists the full context for audit purposes.

```json
{
  "workspaceId": "ws-abc",
  "action": "file.delete",
  "policyId": "policy:file-action",
  "reason": "File deletion requires human approval",
  "riskLevel": "high",
  "blockedContext": { "reason": "no_approval", "path": "/etc/config" },
  "agentId": "agent-xyz",
  "traceId": "trace-123",
  "timestamp": 1700000000000
}
```

## Event Flow

```
Agent requests action
        ↓
Policy evaluation (policy.checked)
        ↓
     verdict?
    /    |    \
allow  deny  require_approval
  |      |         |
policy  policy  approval.required
.allowed .denied      |
         +         (human reviews)
      action.blocked  |
                  approve/deny
                   /      \
          approval.approved approval.denied
                  |              |
             (proceed)      action.blocked
```
