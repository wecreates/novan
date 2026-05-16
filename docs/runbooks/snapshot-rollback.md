# Snapshot & Rollback Runbook

## Overview

The snapshot/rollback system captures pre-execution state for risky workflow steps and provides structured, verified rollback with full event emission.

## Tables

| Table | Purpose |
|---|---|
| `snapshots` | Snapshot header — one per risky step |
| `snapshot_items` | Per-entity before-state captures |
| `rollback_requests` | Rollback lifecycle record |
| `rollback_results` | Per-item restore outcome |
| `recovery_checkpoints` | Execution state checkpoints for replay/recovery |

## Events

| Event | When |
|---|---|
| `snapshot.created` | Snapshot successfully opened |
| `snapshot.failed` | Snapshot creation threw |
| `rollback.requested` | `requestRollback()` called |
| `rollback.started` | Snapshot found + verification passed |
| `rollback.completed` | All restorable items restored |
| `rollback.failed` | No snapshot found OR restore failed |
| `recovery.checkpoint.created` | Checkpoint saved mid-run |
| `recovery.checkpoint.restored` | Executor resumed from checkpoint |

## Snapshot Lifecycle

```typescript
import { createSnapshot, finalizeSnapshot, addSnapshotItem } from '@ops/service-recovery'

// 1. Open snapshot before risky step
const snapshotId = await createSnapshot({
  workspaceId, runId, traceId,
  stepId: 'step_payment',
  description: 'Before payment processing',
})

// 2. Capture each entity that may be modified
await addSnapshotItem({
  snapshotId, workspaceId,
  itemType:    'db_row',
  entityType:  'orders',
  entityId:    orderId,
  beforeState: { status: 'pending', amount: 100_00 },
})

// 3. Finalize with count/size
await finalizeSnapshot(snapshotId, 1, 256)
```

## Rollback Lifecycle

```typescript
import { requestRollback, getRollbackRequest } from '@ops/service-recovery'

const result = await requestRollback({
  workspaceId, runId, traceId,
  reason:      'Step failed — rolling back payment state',
  requestedBy: 'recovery-worker',
  snapshotId,
})

// result.status: 'completed' | 'failed' | 'no_snapshot'
// result.itemsRestored, result.itemsFailed, result.warnings

// Query the full request + results
const { request, results } = await getRollbackRequest(result.requestId)
```

## Rollback Verification

Before any restore, the verifier assesses each item:

| itemType | Restorability |
|---|---|
| `db_row` | `restorable` — before-state can be re-applied |
| `file` | `partial` — content restores but filesystem metadata may differ |
| `api_state` | `not_restorable` — external side effects cannot be undone |
| `custom` | `unknown` — depends on registered handler |

```typescript
import { verifyRollback, getSnapshotItems } from '@ops/service-recovery'

const items  = await getSnapshotItems(snapshotId)
const report = verifyRollback(snapshotId, runId, items)
// report.canProceed, report.warnings, report.verifications[]
```

Rollback is blocked if `canProceed === false` (zero restorable items).

## Checkpoints

Checkpoints save execution state mid-run, enabling safe recovery without re-running completed steps.

```typescript
import { createCheckpoint, getLatestCheckpoint, markCheckpointRestored } from '@ops/service-recovery'

// Save checkpoint after completing a step
const cpId = await createCheckpoint({
  workspaceId, runId, traceId,
  stepId:         'step_b',
  completedSteps: ['step_a', 'step_b'],
  state:          { outputA: {...}, outputB: {...} },
  snapshotId,
})

// On worker restart: load latest checkpoint
const cp = await getLatestCheckpoint(runId)
// cp.completedSteps → resume executor from here

// Mark restored (read-only — executor handles actual replay)
await markCheckpointRestored(cpId, 'recovery-worker', traceId)
```
