# Observability Architecture

## Design Principles

1. **Every trace references real events** — no synthetic or fake records
2. **Replay is read-only** — reconstruction never mutates workflow state
3. **Failure lineage is explicit** — the causal chain is written at failure time, not inferred later
4. **Health uses real runtime signals** — BullMQ queue counts, heartbeat timestamps only
5. **All writes emit canonical events** — `observability.*` events flow through the event bus

## Data Flow

```
Worker / Service
      │
      ▼
emitEvent(type, workspaceId, payload)
      │
      ├─► events table (Postgres) — canonical event log
      │
      └─► @ops/service-observability
            ├─ recordEventTrace()     → event_traces
            ├─ openWorkflowTrace()    → workflow_traces
            ├─ openTaskTrace()        → task_traces
            ├─ recordApprovalTrace()  → approval_traces
            ├─ recordPolicyTrace()    → policy_traces
            ├─ recordWorkerTrace()    → worker_traces
            ├─ recordQueueTrace()     → queue_traces
            └─ openFailureLineage()   → failure_lineages
```

## Replay Architecture

```
readWorkflowReplay(runId, workspaceId)
      │
      ├─ workflowRuns     (source of truth)
      ├─ stepRuns         (step execution results)
      ├─ approvals        (approval gate records)
      ├─ events           (all events for traceId)
      ├─ workflow_traces  (timing/duration)
      ├─ task_traces      (step timing)
      ├─ approval_traces  (approval resolution)
      └─ failure_lineages (root cause if failed)

Returns: WorkflowReplaySummary (read-only snapshot)
```

## Health Architecture

```
BullMQ Queue (live)
      │
      ▼
reportQueueHealth(queue)
      ├─ queue.getJobCounts() → real counts
      ├─ classifyQueueHealth() → HealthStatus
      └─ emitEvent('observability.health.checked')

Worker heartbeat data
      │
      ▼
buildWorkerHealthFromHeartbeat(heartbeat, worker, startedAt)
      ├─ classifyWorkerHealth() → HealthStatus (based on heartbeat age)
      └─ emitWorkerHealthEvent()
```

## Packages

| Package | Role |
|---|---|
| `@ops/service-observability` | Trace writers, replay reader, health reporters |
| `@ops/runtime-kernel` | `HealthStatus` types, `classifyQueueHealth`, `classifyWorkerHealth`, `generateTraceId`, `createTraceContext` |
| `@ops/db` | All trace + lineage tables |
| `@ops/event-contracts` | `observability.*`, `replay.*` event types + payload schemas |

## Trace ID Propagation

Every job, event, and DB record carries a `traceId`. Correlation follows:

```
API request → traceId generated
    ↓
workflow job enqueued  (traceId in job data)
    ↓
workflow-worker picks up job
    ↓
executeWorkflowRun(traceId)
    ↓
each step execution → taskTrace(traceId)
    ↓
approval request → approvalTrace(traceId)
    ↓
policy check → policyTrace(traceId)
    ↓
all events share the same traceId → queryable via readExecutionTrace(traceId)
```
