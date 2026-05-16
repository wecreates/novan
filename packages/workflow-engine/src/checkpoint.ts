/**
 * Checkpoint — lightweight run-state snapshots enabling mid-workflow recovery
 * and replay without re-running already-completed steps.
 *
 * The caller is responsible for persisting / loading the serialised checkpoint;
 * this module only handles the data-shape creation and restoration.
 */
import type { WorkflowRunId } from '@ops/shared-types'

export interface WorkflowCheckpoint {
  runId:          WorkflowRunId
  completedSteps: string[]
  stepOutputs:    Record<string, Record<string, unknown>>
  currentWave:    number
  savedAt:        number   // Unix ms
}

/**
 * Create a checkpoint snapshot from current execution state.
 */
export function createCheckpoint(
  runId:          WorkflowRunId,
  completedSteps: string[],
  stepOutputs:    Record<string, Record<string, unknown>>,
  currentWave:    number,
): WorkflowCheckpoint {
  return {
    runId,
    completedSteps: [...completedSteps],
    stepOutputs:    { ...stepOutputs },
    currentWave,
    savedAt: Date.now(),
  }
}

/**
 * Restore mutable execution state from a checkpoint.
 * Returns fresh copies of every collection so callers can mutate freely.
 */
export function restoreFromCheckpoint(checkpoint: WorkflowCheckpoint): {
  completedSteps: Set<string>
  stepOutputs:    Record<string, Record<string, unknown>>
  currentWave:    number
} {
  return {
    completedSteps: new Set(checkpoint.completedSteps),
    stepOutputs:    Object.fromEntries(
      Object.entries(checkpoint.stepOutputs).map(([k, v]) => [k, { ...v }]),
    ),
    currentWave: checkpoint.currentWave,
  }
}
