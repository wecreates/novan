# @ops/workflow-engine

Workflow state machine, step executor registry, retry policies, and checkpoint/replay for Ops Platform.

Used by:
- `apps/api` — workflow registration and run scheduling
- `workers/workflow-worker` — step-by-step execution
- `workers/recovery-worker` — rollback and retry coordination

---

## State Machine

```
pending → running → completed
                 ↘ failed → (retry → running | escalate)
                 ↘ awaiting_approval → (approved → running | rejected → failed)
running → paused → running
running → cancelled
```

---

## Step Types

| Type | Description |
|---|---|
| `action` | Generic executable action (custom executor) |
| `browser` | Playwright browser automation via `browser-worker` |
| `ai_inference` | AI model call via `@ops/provider-router` |
| `memory_read` | Vector memory retrieval via `@ops/db` + pgvector |
| `memory_write` | Persist data to semantic memory |

---

## Registering a Custom Executor

```typescript
import { registerExecutor } from '@ops/workflow-engine'
import type { StepExecutor } from '@ops/workflow-engine'

const myExecutor: StepExecutor = async (ctx) => {
  const { step, previousOutputs, runId, traceId } = ctx

  // Access outputs from prior steps
  const priorData = previousOutputs['step-id-here']

  return {
    status: 'completed',
    output: { result: 'done' },
    // Optional rollback instruction
    rollback: {
      type: 'api_call',
      config: { url: 'https://example.com/rollback', method: 'POST' },
      timeout: 5000,
    },
  }
}

registerExecutor('action', myExecutor)
```

The executor receives a `StepExecutionContext`:

```typescript
interface StepExecutionContext {
  runId:           WorkflowRunId
  workspaceId:     WorkspaceId
  step:            StepDefinition
  previousOutputs: Record<string, Record<string, unknown>>  // stepId → output
  attempt:         number   // 1-indexed
  traceId:         string
}
```

---

## Retry Policies

Retry configuration is part of `StepDefinition`. The default policy:

```typescript
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:       3,
  backoffMs:         500,
  backoffMultiplier: 2,
  maxBackoffMs:      30_000,
}
```

Backoff is exponential with full jitter:

```
delay = min(backoffMs × multiplier^(attempt-1) + jitter, maxBackoffMs)
```

Use `computeBackoff(policy, attempt)` and `shouldRetry(policy, attempt)` from this package.

---

## Example Workflow Definition

```json
{
  "id": "wf-onboard-customer",
  "name": "Customer Onboarding",
  "version": 1,
  "trigger": { "type": "api" },
  "steps": [
    {
      "id": "enrich-company",
      "type": "ai_inference",
      "name": "Enrich Company Data",
      "config": {
        "tier": "medium",
        "prompt": "Summarize company {{inputs.domain}}"
      },
      "retryPolicy": {
        "maxAttempts": 3,
        "backoffMs": 1000,
        "backoffMultiplier": 2,
        "maxBackoffMs": 10000
      },
      "dependsOn": []
    },
    {
      "id": "save-to-memory",
      "type": "memory_write",
      "name": "Save Company Summary",
      "config": {
        "content": "{{steps.enrich-company.output.summary}}",
        "tags": ["company", "onboarding"]
      },
      "dependsOn": ["enrich-company"]
    },
    {
      "id": "approval-gate",
      "type": "action",
      "name": "Manager Approval",
      "config": { "requiresApproval": true },
      "dependsOn": ["save-to-memory"]
    }
  ]
}
```

Steps in `dependsOn: []` run in parallel. Steps with declared dependencies wait for all dependencies to reach `completed`.

---

## Checkpoint / Replay

Checkpoints are automatically saved after each step completes.

```typescript
import { createCheckpoint, restoreFromCheckpoint } from '@ops/workflow-engine'

// Save
const checkpoint = createCheckpoint(runId, completedStepId, currentState, completedStepIds)

// Replay from checkpoint
await engine.execute(run, definition, { fromCheckpoint: checkpoint })

// Or replay from a specific step
await engine.execute(run, definition, { fromStepId: 'save-to-memory' })
```

---

## Execution Planning

```typescript
import { buildExecutionPlan, getReadySteps } from '@ops/workflow-engine'

const plan = buildExecutionPlan(definition)    // topological sort with parallel groups
const ready = getReadySteps(plan, completedIds) // steps with all deps satisfied
```
