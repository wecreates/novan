/**
 * Snapshot/rollback smoke tests — compile-time contract verification.
 * These verify the API surface typechecks correctly without a live DB.
 *
 * Manual test plan:
 *   1. Create workflow checkpoint
 *   2. Create snapshot
 *   3. Request rollback
 *   4. Confirm rollback events
 *   5. Trigger failed rollback (no snapshot)
 *   6. Confirm failure is visible
 */

// ─── 1. Checkpoint creation ───────────────────────────────────────────────────
import type { CreateCheckpointInput } from '../checkpoint/manager.js'

const checkpointInput: CreateCheckpointInput = {
  workspaceId:    'ws_test',
  runId:          'run_001',
  stepId:         'step_a',
  traceId:        'tr_abc123',
  completedSteps: ['step_a'],
  state:          { output: { result: 'ok' } },
  snapshotId:     'snap_001',
}
void checkpointInput

// ─── 2. Snapshot creation ─────────────────────────────────────────────────────
import type { CreateSnapshotInput } from '../snapshot/manager.js'

const snapshotInput: CreateSnapshotInput = {
  workspaceId: 'ws_test',
  runId:       'run_001',
  traceId:     'tr_abc123',
  stepId:      'step_payment',
  description: 'Before payment processing',
}
void snapshotInput

import type { SnapshotItemInput } from '../snapshot/items.js'

const itemInput: SnapshotItemInput = {
  snapshotId:  'snap_001',
  workspaceId: 'ws_test',
  itemType:    'db_row',
  entityType:  'orders',
  entityId:    'order_42',
  beforeState: { status: 'pending', amount: 10000 },
}
void itemInput

// ─── 3. Rollback request ──────────────────────────────────────────────────────
import type { RequestRollbackInput, RollbackLifecycleResult } from '../rollback/lifecycle.js'

const rollbackInput: RequestRollbackInput = {
  workspaceId: 'ws_test',
  runId:       'run_001',
  traceId:     'tr_abc123',
  reason:      'Step failed — rolling back payment state',
  requestedBy: 'recovery-worker',
  snapshotId:  'snap_001',
}
void rollbackInput

// ─── 4. Rollback result shape ─────────────────────────────────────────────────
const result: RollbackLifecycleResult = {
  requestId:    'req_001',
  status:       'completed',
  itemsRestored: 1,
  itemsFailed:   0,
  warnings:     [],
}
void result

// ─── 5. Failed rollback (no_snapshot path) ────────────────────────────────────
const failedResult: RollbackLifecycleResult = {
  requestId:    'req_002',
  status:       'no_snapshot',
  itemsRestored: 0,
  itemsFailed:   0,
  warnings:     ['No active snapshot found'],
}
void failedResult

// ─── 6. Verification report ───────────────────────────────────────────────────
import type { RollbackVerificationReport } from '../rollback/verifier.js'

const verificationReport: RollbackVerificationReport = {
  snapshotId:          'snap_001',
  runId:               'run_001',
  totalItems:          3,
  restorable:          2,
  partiallyRestorable: 0,
  notRestorable:       1,
  verifications: [
    { itemId: 'item_1', entityType: 'orders', entityId: 'o1', itemType: 'db_row',    restorable: 'restorable',     reason: 'DB row can be restored' },
    { itemId: 'item_2', entityType: 'orders', entityId: 'o2', itemType: 'db_row',    restorable: 'restorable',     reason: 'DB row can be restored' },
    { itemId: 'item_3', entityType: 'stripe', entityId: 'ch_x', itemType: 'api_state', restorable: 'not_restorable', reason: 'External API state cannot be reversed' },
  ],
  canProceed:  true,
  warnings:    ['1 items cannot be restored (external side effects)'],
  generatedAt: Date.now(),
}
void verificationReport

export {}
