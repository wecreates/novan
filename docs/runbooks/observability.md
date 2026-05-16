# Observability Runbook

## Overview

The observability system provides structured tracing, failure lineage, workflow replay, and health reporting across all workers and services.

## Trace Types

| Table | Purpose | Key columns |
|---|---|---|
| `event_traces` | Persists each emitted system event | `traceId`, `eventId`, `eventType`, `source` |
| `workflow_traces` | Run lifecycle (open on start, close on complete/fail) | `traceId`, `runId`, `workflowId`, `status`, `durationMs` |
| `task_traces` | Per-step execution (open on start, close on result) | `traceId`, `runId`, `stepId`, `stepType`, `attempt` |
| `approval_traces` | Approval request + resolution | `traceId`, `approvalId`, `runId`, `status` |
| `policy_traces` | Policy engine evaluation record | `traceId`, `policyId`, `verdict`, `riskLevel` |
| `worker_traces` | Worker lifecycle events (started / heartbeat / stopped) | `traceId`, `workerId`, `workerName`, `event` |
| `queue_traces` | Queue job lifecycle (created/started/completed/failed/…) | `traceId`, `queueName`, `jobId`, `event` |
| `failure_lineages` | Causal event chain for failed runs | `traceId`, `runId`, `rootCause`, `failureChain[]` |

## Events

| Event | When emitted |
|---|---|
| `observability.trace.created` | Any trace record is written |
| `observability.health.checked` | Queue or worker health check runs |
| `observability.failure.linked` | A `failure_lineage` row is opened |
| `replay.workflow.requested` | Replay read requested |
| `replay.workflow.completed` | Replay read succeeded |
| `replay.workflow.failed` | Replay read failed |

## Workflow Replay

Replay is **read-only** — it reconstructs what happened but never mutates state.

```typescript
import { readWorkflowReplay, readTraceTimeline } from '@ops/service-observability'

// Full run reconstruction
const summary = await readWorkflowReplay(runId, workspaceId)
// summary.run, summary.steps, summary.traceEvents, summary.failureLineage …

// Ordered event timeline for a trace
const timeline = await readTraceTimeline(traceId)
// timeline.events (time-ordered), timeline.taskTraces, timeline.workflowTrace …
```

## Health Reporting

Health reports use **real runtime signals only** — no fake metrics.

```typescript
import { reportQueueHealth } from '@ops/service-observability'
import { Queue } from 'bullmq'

const queue  = new Queue('workflow', { connection })
const report = await reportQueueHealth(queue, { workspaceId, emitHealthEvent: true })
// report.status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
// report.errorRate, report.waitingCount, report.failedCount …
```

Health thresholds (from `@ops/runtime-kernel`):

| Threshold | Degraded | Unhealthy |
|---|---|---|
| Error rate | ≥ 5% | ≥ 20% |
| Stalled count | ≥ 3 | ≥ 10 |
| Heartbeat age | ≥ 60 s | ≥ 300 s |

## Failure Lineage

```typescript
import { openFailureLineage, getFailureLineage } from '@ops/service-observability'

// Open a lineage on run failure
const id = await openFailureLineage({
  workspaceId, runId, traceId,
  failureChain: [
    { eventId: 'evt_1', eventType: 'step.failed', timestamp: Date.now(), message: 'timeout' },
  ],
  affectedSteps: ['step_a', 'step_b'],
  rootCause: 'Step A timed out after 30s',
})

// Query the lineage for a failed run
const lineage = await getFailureLineage(runId)
```
