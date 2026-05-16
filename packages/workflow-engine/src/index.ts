/**
 * @ops/workflow-engine — workflow execution contracts and state machine.
 *
 * Defines the interfaces implemented by:
 *   - apps/api: workflow registration and scheduling
 *   - workers/workflow-worker: step execution
 *   - services/recovery: rollback and retry coordination
 *
 * State machine transitions:
 *   pending → running → completed
 *                    ↘ failed → (retry → running | escalate)
 *                    ↘ awaiting_approval → (approved → running | rejected → failed)
 *   running → paused → running
 *   running → cancelled
 */
import type {
  WorkflowDefinition, WorkflowRun, WorkflowRunId,
  StepDefinition, StepRun, StepType,
  WorkspaceId, WorkflowStatus, StepStatus,
} from '@ops/shared-types'

// ─── Step executor interface ───────────────────────────────────────────────────

export interface StepExecutionContext {
  runId:        WorkflowRunId
  workspaceId:  WorkspaceId
  step:         StepDefinition
  previousOutputs: Record<string, Record<string, unknown>>
  attempt:      number
  traceId:      string
}

export interface StepExecutionResult {
  status:  'completed' | 'failed' | 'awaiting_approval'
  output:  Record<string, unknown>
  error?:  string
  rollback?: RollbackInstruction
}

export interface RollbackInstruction {
  type:    'api_call' | 'db_restore' | 'file_delete' | 'custom'
  config:  Record<string, unknown>
  timeout: number   // ms
}

export type StepExecutor = (ctx: StepExecutionContext) => Promise<StepExecutionResult>

// ─── Executor registry ────────────────────────────────────────────────────────

export interface StepExecutorRegistry {
  register(type: StepType, executor: StepExecutor): void
  get(type: StepType): StepExecutor | null
  list(): StepType[]
}

// ─── Workflow scheduler ───────────────────────────────────────────────────────

export interface WorkflowScheduler {
  /** Enqueue a workflow run for immediate or delayed execution. */
  enqueue(run: WorkflowRun, delayMs?: number): Promise<void>
  /** Cancel a queued or running workflow. */
  cancel(runId: WorkflowRunId): Promise<void>
  /** Pause execution after current step completes. */
  pause(runId: WorkflowRunId): Promise<void>
  /** Resume a paused workflow. */
  resume(runId: WorkflowRunId): Promise<void>
}

// ─── State transitions ────────────────────────────────────────────────────────

export const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  pending:           ['running', 'cancelled'],
  running:           ['completed', 'failed', 'paused', 'awaiting_approval', 'cancelled'],
  paused:            ['running', 'cancelled'],
  awaiting_approval: ['running', 'failed', 'cancelled'],
  completed:         [],
  failed:            ['running'],  // retry only
  cancelled:         [],
}

export function isValidTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

export const VALID_STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending:   ['running', 'skipped'],
  running:   ['completed', 'failed', 'retrying'],
  retrying:  ['running', 'failed'],
  completed: [],
  failed:    [],
  skipped:   [],
}

// ─── Recovery interface ───────────────────────────────────────────────────────

export interface RecoveryStrategy {
  type:     'retry' | 'rollback' | 'skip' | 'compensate' | 'escalate'
  config:   Record<string, unknown>
  timeout:  number
}

export interface RecoveryPlan {
  runId:      WorkflowRunId
  strategy:   RecoveryStrategy
  steps:      RollbackInstruction[]
  triggeredAt: number
  reason:     string
}

// ─── Checkpoint / replay ──────────────────────────────────────────────────────

export interface WorkflowCheckpoint {
  runId:       WorkflowRunId
  stepId:      string
  state:       Record<string, unknown>
  completedSteps: string[]
  savedAt:     number
}

export interface ReplayOptions {
  fromCheckpoint?: WorkflowCheckpoint
  fromStepId?:     string
  overrideContext?: Record<string, unknown>
}

// ─── Workflow engine interface ────────────────────────────────────────────────

export interface WorkflowEngine {
  /** Start execution of a workflow run. */
  execute(run: WorkflowRun, definition: WorkflowDefinition, opts?: ReplayOptions): Promise<void>
  /** Handle completion of an individual step. */
  onStepComplete(runId: WorkflowRunId, stepRun: StepRun): Promise<void>
  /** Handle failure of an individual step. */
  onStepFailure(runId: WorkflowRunId, stepRun: StepRun, error: string): Promise<void>
  /** Approve a pending approval gate. */
  approveStep(runId: WorkflowRunId, stepId: string, userId: string): Promise<void>
  /** Reject a pending approval gate. */
  rejectStep(runId: WorkflowRunId, stepId: string, userId: string, reason: string): Promise<void>
  /** Recover a failed run. */
  recover(runId: WorkflowRunId, plan: RecoveryPlan): Promise<void>
}

// ─── Policy-aware step execution ──────────────────────────────────────────────

import type { AutonomyLevel } from '@ops/policy-engine'

export type { AutonomyLevel }

/**
 * Workflow policy context — used when evaluating whether a step may execute.
 * The executor passes this to the policy engine before running any step.
 */
export interface WorkflowPolicyContext {
  workspaceId:   string
  workflowId:    string
  runId:         string
  stepId:        string
  stepType:      string
  action:        string          // derived: 'workflow.execute_step'
  riskLevel:     'low' | 'medium' | 'high' | 'critical'
  autonomyLevel: AutonomyLevel
  traceId:       string
  agentId?:      string
}

/**
 * Result of a policy check before step execution.
 */
export interface StepPolicyResult {
  allowed:       boolean
  requiresApproval: boolean
  blocked:       boolean
  reason:        string
  approvalId?:   string  // set if requiresApproval=true and approval was created
}

// ─── Runtime modules ──────────────────────────────────────────────────────────

export type { ExecutionPlan } from './planner.js'
export { buildExecutionPlan, getReadySteps } from './planner.js'

export type { RetryPolicy } from './retry.js'
export { DEFAULT_RETRY_POLICY, computeBackoff, shouldRetry } from './retry.js'

export type { WorkflowCheckpoint as RunCheckpoint } from './checkpoint.js'
export { createCheckpoint, restoreFromCheckpoint } from './checkpoint.js'

export { registerExecutor, getExecutor, listRegisteredTypes, executeStep } from './executors/index.js'

// Side-effect imports ensure executor registration when the package is imported.
// The actual registration happens inside executors/index.js (which imports them).

