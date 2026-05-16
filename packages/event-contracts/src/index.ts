/**
 * @ops/event-contracts — canonical event type registry.
 *
 * Every inter-service event is defined here with its exact payload type.
 * All services import from this package — never define event shapes inline.
 *
 * Versioning: bump EVENT_SCHEMA_VERSION when payload shapes change.
 * Old consumers must handle both versions during rolling deploys.
 */
import type {
  WorkflowRunId, StepId, WorkspaceId, EventId,
  MemoryId, ApprovalId, UserId,
} from '@ops/shared-types'

export const EVENT_SCHEMA_VERSION = 1

// ─── Event type registry ──────────────────────────────────────────────────────

export const EVENT_TYPES = {
  // Workflow lifecycle
  WORKFLOW_RUN_CREATED:    'workflow.run.created',
  WORKFLOW_RUN_STARTED:    'workflow.run.started',
  WORKFLOW_RUN_COMPLETED:  'workflow.run.completed',
  WORKFLOW_RUN_FAILED:     'workflow.run.failed',
  WORKFLOW_RUN_CANCELLED:  'workflow.run.cancelled',
  WORKFLOW_RUN_PAUSED:     'workflow.run.paused',
  // Step lifecycle
  STEP_STARTED:            'step.started',
  STEP_COMPLETED:          'step.completed',
  STEP_FAILED:             'step.failed',
  STEP_RETRYING:           'step.retrying',
  // Approval
  APPROVAL_REQUESTED:      'approval.requested',
  APPROVAL_RESOLVED:       'approval.resolved',
  APPROVAL_EXPIRED:        'approval.expired',
  // Memory
  MEMORY_CREATED:          'memory.created',
  MEMORY_UPDATED:          'memory.updated',
  MEMORY_INDEXED:          'memory.indexed',
  MEMORY_RETRIEVAL:        'memory.retrieval',
  // Browser
  BROWSER_SESSION_STARTED: 'browser.session.started',
  BROWSER_SESSION_ENDED:   'browser.session.ended',
  BROWSER_STEP_COMPLETED:  'browser.step.completed',
  BROWSER_STEP_FAILED:     'browser.step.failed',
  // Recovery (legacy — superseded by granular rollback events below)
  RECOVERY_TRIGGERED:      'recovery.triggered',
  RECOVERY_COMPLETED:      'recovery.completed',
  RECOVERY_FAILED:         'recovery.failed',
  ROLLBACK_TRIGGERED:      'rollback.triggered',
  // Observability
  HEALTH_CHECK_FAILED:     'health.check.failed',
  ANOMALY_DETECTED:        'anomaly.detected',
  SLO_BREACHED:            'slo.breached',
  // Job queue
  JOB_QUEUED:              'job.queued',
  JOB_COMPLETED:           'job.completed',
  JOB_FAILED:              'job.failed',
  JOB_STALLED:             'job.stalled',
  // AI
  AI_INFERENCE_STARTED:    'ai.inference.started',
  AI_INFERENCE_COMPLETED:  'ai.inference.completed',
  AI_INFERENCE_FAILED:     'ai.inference.failed',
  AI_PROVIDER_SWITCHED:    'ai.provider.switched',
  // Worker lifecycle
  WORKER_STARTED:          'worker.started',
  WORKER_HEARTBEAT:        'worker.heartbeat',
  WORKER_STOPPED:          'worker.stopped',
  // Queue job events
  QUEUE_JOB_CREATED:          'queue.job.created',
  QUEUE_JOB_STARTED:          'queue.job.started',
  QUEUE_JOB_COMPLETED:        'queue.job.completed',
  QUEUE_JOB_FAILED:           'queue.job.failed',
  QUEUE_JOB_RETRY_SCHEDULED:  'queue.job.retry_scheduled',
  QUEUE_JOB_DEAD_LETTERED:    'queue.job.dead_lettered',
  // Policy engine events
  POLICY_CHECKED:           'policy.checked',
  POLICY_ALLOWED:           'policy.allowed',
  POLICY_DENIED:            'policy.denied',
  // Approval events (more granular than existing APPROVAL_REQUESTED/RESOLVED)
  APPROVAL_REQUIRED:        'approval.required',
  APPROVAL_APPROVED:        'approval.approved',
  APPROVAL_DENIED:          'approval.denied',
  // Action control
  ACTION_BLOCKED:           'action.blocked',
  // Observability
  OBSERVABILITY_TRACE_CREATED:  'observability.trace.created',
  OBSERVABILITY_HEALTH_CHECKED: 'observability.health.checked',
  OBSERVABILITY_FAILURE_LINKED: 'observability.failure.linked',
  // Replay
  REPLAY_WORKFLOW_REQUESTED:    'replay.workflow.requested',
  REPLAY_WORKFLOW_COMPLETED:    'replay.workflow.completed',
  REPLAY_WORKFLOW_FAILED:       'replay.workflow.failed',
  // Snapshot
  SNAPSHOT_CREATED:             'snapshot.created',
  SNAPSHOT_FAILED:              'snapshot.failed',
  // Rollback
  ROLLBACK_REQUESTED:           'rollback.requested',
  ROLLBACK_STARTED:             'rollback.started',
  ROLLBACK_COMPLETED:           'rollback.completed',
  ROLLBACK_FAILED:              'rollback.failed',
  // Recovery checkpoints
  RECOVERY_CHECKPOINT_CREATED:  'recovery.checkpoint.created',
  RECOVERY_CHECKPOINT_RESTORED: 'recovery.checkpoint.restored',
  // Executive briefings
  BRIEFING_GENERATED:           'briefing.generated',
  BRIEFING_ITEM_CONVERTED:      'briefing.item.converted',
  // Opportunities
  OPPORTUNITY_CREATED:          'opportunity.created',
  OPPORTUNITY_UPDATED:          'opportunity.updated',
  OPPORTUNITY_SCORED:           'opportunity.scored',
  OPPORTUNITY_STATUS_CHANGED:   'opportunity.status.changed',
  OPPORTUNITY_CONVERTED:        'opportunity.converted',
  // Risks
  RISK_CREATED:             'risk.created',
  RISK_UPDATED:             'risk.updated',
  RISK_RESOLVED:            'risk.resolved',
  RISK_MITIGATED:           'risk.mitigated',
  // Insights
  INSIGHT_CREATED:          'insight.created',
  INSIGHT_DISMISSED:        'insight.dismissed',
  INSIGHT_ACTED_ON:         'insight.acted_on',
  // Goals
  GOAL_CREATED:             'goal.created',
  GOAL_UPDATED:             'goal.updated',
  GOAL_PROGRESS_UPDATED:    'goal.progress_updated',
  GOAL_COMPLETED:           'goal.completed',
  GOAL_ACTIVATED:           'goal.activated',
  // Agents
  AGENT_REGISTERED:         'agent.registered',
  AGENT_UPDATED:            'agent.updated',
  AGENT_HEARTBEAT:          'agent.heartbeat',
  AGENT_STATUS_CHANGED:     'agent.status_changed',
  AGENT_DEREGISTERED:       'agent.deregistered',
  // Businesses
  BUSINESS_CREATED:         'business.created',
  BUSINESS_UPDATED:         'business.updated',
  BUSINESS_METRICS_UPDATED: 'business.metrics_updated',
} as const

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

// ─── Payload types ────────────────────────────────────────────────────────────

export interface WorkflowRunCreatedPayload {
  runId:       WorkflowRunId
  workflowId:  string
  workspaceId: WorkspaceId
  triggeredBy: string
  context:     Record<string, unknown>
}

export interface WorkflowRunCompletedPayload {
  runId:        WorkflowRunId
  workflowId:   string
  workspaceId:  WorkspaceId
  durationMs:   number
  stepsTotal:   number
  stepsSuccess: number
  stepsFailed:  number
}

export interface WorkflowRunFailedPayload {
  runId:        WorkflowRunId
  workflowId:   string
  workspaceId:  WorkspaceId
  errorMessage: string
  failedStepId: StepId | null
  attempt:      number
  willRetry:    boolean
}

export interface StepCompletedPayload {
  runId:       WorkflowRunId
  stepId:      StepId
  workspaceId: WorkspaceId
  durationMs:  number
  output:      Record<string, unknown>
}

export interface StepFailedPayload {
  runId:        WorkflowRunId
  stepId:       StepId
  workspaceId:  WorkspaceId
  errorMessage: string
  attempt:      number
  willRetry:    boolean
}

export interface ApprovalRequestedPayload {
  approvalId:     ApprovalId
  runId:          WorkflowRunId
  stepId:         StepId
  workspaceId:    WorkspaceId
  operationLabel: string
  risk:           'low' | 'medium' | 'high' | 'critical'
  expiresAt:      number
}

export interface ApprovalResolvedPayload {
  approvalId:  ApprovalId
  runId:       WorkflowRunId
  stepId:      StepId
  workspaceId: WorkspaceId
  approved:    boolean
  resolvedBy:  UserId
}

export interface MemoryCreatedPayload {
  memoryId:    MemoryId
  workspaceId: WorkspaceId
  type:        string
  tags:        string[]
}

export interface MemoryIndexedPayload {
  workspaceId: WorkspaceId
  count:       number
  durationMs:  number
}

export interface RecoveryTriggeredPayload {
  runId:       WorkflowRunId
  workspaceId: WorkspaceId
  reason:      string
  strategy:    'retry' | 'rollback' | 'skip' | 'escalate'
}

export interface AnomalyDetectedPayload {
  workspaceId: WorkspaceId
  service:     string
  type:        string
  severity:    'low' | 'medium' | 'high' | 'critical'
  description: string
  metric:      string
  value:       number
  threshold:   number
}

export interface SLOBreachedPayload {
  workspaceId: WorkspaceId
  sloId:       string
  sloName:     string
  target:      number
  current:     number
  severity:    'major' | 'critical'
}

export interface AIInferenceCompletedPayload {
  workspaceId:  WorkspaceId
  provider:     string
  model:        string
  promptTokens: number
  outputTokens: number
  latencyMs:    number
  cached:       boolean
}

export interface AIProviderSwitchedPayload {
  workspaceId: WorkspaceId
  fromProvider: string
  toProvider:   string
  reason:       'failure' | 'cost' | 'latency' | 'manual'
}

export interface PolicyCheckedPayload {
  workspaceId:  string
  action:       string
  policyId:     string
  policyName:   string
  verdict:      'allow' | 'deny' | 'require_approval'
  riskLevel:    'low' | 'medium' | 'high' | 'critical'
  agentId:      string | null
  traceId:      string | null
  timestamp:    number
}

export interface PolicyDeniedPayload {
  workspaceId:  string
  action:       string
  policyId:     string
  reason:       string
  riskLevel:    'low' | 'medium' | 'high' | 'critical'
  agentId:      string | null
  traceId:      string | null
  timestamp:    number
}

export interface ApprovalRequiredPayload {
  workspaceId:    string
  action:         string
  policyId:       string
  riskLevel:      'low' | 'medium' | 'high' | 'critical'
  operationLabel: string
  agentId:        string | null
  traceId:        string | null
  timestamp:      number
}

export interface ApprovalResolvedDetailPayload {
  approvalId:   string
  workspaceId:  string
  resolvedBy:   string
  traceId:      string | null
  timestamp:    number
}

export interface ActionBlockedPayload {
  workspaceId:    string
  action:         string
  policyId:       string
  reason:         string
  riskLevel:      'low' | 'medium' | 'high' | 'critical'
  blockedContext: Record<string, unknown>
  agentId:        string | null
  traceId:        string | null
  timestamp:      number
}

// ─── Observability payload types ─────────────────────────────────────────────

export interface ObservabilityTraceCreatedPayload {
  traceId:     string
  traceType:   'event' | 'workflow' | 'task' | 'approval' | 'policy' | 'worker' | 'queue' | 'failure'
  workspaceId: string
  refId:       string
  refType:     string
  timestamp:   number
}

export interface ObservabilityHealthCheckedPayload {
  workspaceId: string
  target:      'queue' | 'worker'
  targetId:    string
  healthy:     boolean
  metrics:     Record<string, number>
  timestamp:   number
}

export interface ObservabilityFailureLinkedPayload {
  workspaceId:    string
  failureId:      string
  runId:          string
  linkedEventIds: string[]
  rootCause:      string | null
  timestamp:      number
}

export interface ReplayWorkflowRequestedPayload {
  workspaceId: string
  runId:       string
  requestedBy: string
  fromStepId?: string
  traceId:     string
  timestamp:   number
}

export interface ReplayWorkflowCompletedPayload {
  workspaceId:   string
  runId:         string
  replayRunId:   string
  stepsReplayed: number
  timestamp:     number
}

export interface ReplayWorkflowFailedPayload {
  workspaceId: string
  runId:       string
  error:       string
  timestamp:   number
}

// ─── Snapshot payload types ───────────────────────────────────────────────────

export interface SnapshotCreatedPayload {
  workspaceId: string
  snapshotId:  string
  runId:       string
  stepId?:     string
  itemCount:   number
  timestamp:   number
}

export interface SnapshotFailedPayload {
  workspaceId: string
  runId:       string
  stepId?:     string
  error:       string
  timestamp:   number
}

export interface RollbackRequestedPayload {
  workspaceId: string
  runId:       string
  requestId:   string
  reason:      string
  requestedBy: string
  snapshotId?: string
  timestamp:   number
}

export interface RollbackStartedPayload {
  workspaceId: string
  runId:       string
  requestId:   string
  snapshotId:  string
  timestamp:   number
}

export interface RollbackCompletedPayload {
  workspaceId:   string
  runId:         string
  requestId:     string
  itemsRestored: number
  durationMs:    number
  timestamp:     number
}

export interface RollbackFailedPayload {
  workspaceId: string
  runId:       string
  requestId:   string
  error:       string
  itemsFailed: number
  timestamp:   number
}

export interface RecoveryCheckpointCreatedPayload {
  workspaceId:  string
  checkpointId: string
  runId:        string
  stepId:       string
  timestamp:    number
}

export interface RecoveryCheckpointRestoredPayload {
  workspaceId:  string
  checkpointId: string
  runId:        string
  restoredBy:   string
  timestamp:    number
}

// ─── Typed event map ──────────────────────────────────────────────────────────

export interface EventPayloadMap {
  'workflow.run.created':   WorkflowRunCreatedPayload
  'workflow.run.completed': WorkflowRunCompletedPayload
  'workflow.run.failed':    WorkflowRunFailedPayload
  'step.completed':         StepCompletedPayload
  'step.failed':            StepFailedPayload
  'approval.requested':     ApprovalRequestedPayload
  'approval.resolved':      ApprovalResolvedPayload
  'memory.created':         MemoryCreatedPayload
  'memory.indexed':         MemoryIndexedPayload
  'recovery.triggered':     RecoveryTriggeredPayload
  'anomaly.detected':       AnomalyDetectedPayload
  'slo.breached':           SLOBreachedPayload
  'ai.inference.completed': AIInferenceCompletedPayload
  'ai.provider.switched':   AIProviderSwitchedPayload
  'policy.checked':    PolicyCheckedPayload
  'policy.denied':     PolicyDeniedPayload
  'approval.required': ApprovalRequiredPayload
  'approval.approved': ApprovalResolvedDetailPayload
  'approval.denied':   ApprovalResolvedDetailPayload
  'action.blocked':    ActionBlockedPayload
  // Observability
  'observability.trace.created':  ObservabilityTraceCreatedPayload
  'observability.health.checked': ObservabilityHealthCheckedPayload
  'observability.failure.linked': ObservabilityFailureLinkedPayload
  'replay.workflow.requested':    ReplayWorkflowRequestedPayload
  'replay.workflow.completed':    ReplayWorkflowCompletedPayload
  'replay.workflow.failed':       ReplayWorkflowFailedPayload
  // Snapshot / Rollback
  'snapshot.created':             SnapshotCreatedPayload
  'snapshot.failed':              SnapshotFailedPayload
  'rollback.requested':           RollbackRequestedPayload
  'rollback.started':             RollbackStartedPayload
  'rollback.completed':           RollbackCompletedPayload
  'rollback.failed':              RollbackFailedPayload
  'recovery.checkpoint.created':  RecoveryCheckpointCreatedPayload
  'recovery.checkpoint.restored': RecoveryCheckpointRestoredPayload
  // Briefings
  'briefing.generated':           BriefingGeneratedPayload
  'briefing.item.converted':      BriefingItemConvertedPayload
  // Opportunities
  'opportunity.created':          OpportunityCreatedPayload
  'opportunity.updated':          OpportunityUpdatedPayload
  'opportunity.scored':           OpportunityScoredPayload
  'opportunity.status.changed':   OpportunityStatusChangedPayload
  'opportunity.converted':        OpportunityConvertedPayload
  // Risks
  'risk.created':   RiskCreatedPayload
  'risk.updated':   RiskUpdatedPayload
  'risk.resolved':  RiskResolvedPayload
  'risk.mitigated': RiskMitigatedPayload
  // Insights
  'insight.created':    InsightCreatedPayload
  'insight.dismissed':  InsightDismissedPayload
  'insight.acted_on':   InsightActedOnPayload
  // Goals
  'goal.created':          GoalCreatedPayload
  'goal.updated':          GoalUpdatedPayload
  'goal.progress_updated': GoalProgressUpdatedPayload
  'goal.completed':        GoalCompletedPayload
  'goal.activated':        GoalCreatedPayload
  // Agents
  'agent.registered':    AgentRegisteredPayload
  'agent.updated':       AgentRegisteredPayload
  'agent.heartbeat':     AgentHeartbeatPayload
  'agent.status_changed': AgentStatusChangedPayload
  'agent.deregistered':  AgentRegisteredPayload
  // Businesses
  'business.created':          BusinessCreatedPayload
  'business.updated':          BusinessUpdatedPayload
  'business.metrics_updated':  BusinessUpdatedPayload
}

// ─── Briefing payload types ───────────────────────────────────────────────────

export interface BriefingGeneratedPayload {
  workspaceId:  string
  briefingId:   string
  requestedBy:  string
  itemCount:    number
  sections:     string[]
  durationMs:   number
  traceId:      string
  timestamp:    number
}

export interface BriefingItemConvertedPayload {
  workspaceId:  string
  briefingId:   string
  itemId:       string
  section:      string
  title:        string
  runId:        string
  workflowId:   string
  convertedBy:  string
  timestamp:    number
}

// ─── Opportunity payload types ────────────────────────────────────────────────

export interface OpportunityCreatedPayload {
  workspaceId:    string
  opportunityId:  string
  title:          string
  type:           string
  status:         string
  confidence:     number
  timestamp:      number
}

export interface OpportunityUpdatedPayload {
  workspaceId:    string
  opportunityId:  string
  fields:         string[]
  timestamp:      number
}

export interface OpportunityScoredPayload {
  workspaceId:    string
  opportunityId:  string
  score:          number
  scoreBreakdown: Record<string, number>
  timestamp:      number
}

export interface OpportunityStatusChangedPayload {
  workspaceId:    string
  opportunityId:  string
  fromStatus:     string
  toStatus:       string
  changedBy:      string
  timestamp:      number
}

export interface OpportunityConvertedPayload {
  workspaceId:    string
  opportunityId:  string
  title:          string
  runId:          string
  workflowId:     string
  convertedBy:    string
  timestamp:      number
}

// ─── Risk payload types ───────────────────────────────────────────────────────

export interface RiskCreatedPayload {
  workspaceId: string; riskId: string; title: string; severity: string; riskScore: number; timestamp: number
}
export interface RiskUpdatedPayload {
  workspaceId: string; riskId: string; fields: string[]; timestamp: number
}
export interface RiskResolvedPayload {
  workspaceId: string; riskId: string; resolvedAt: number; timestamp: number
}
export interface RiskMitigatedPayload {
  workspaceId: string; riskId: string; mitigationDescription: string; timestamp: number
}

// ─── Insight payload types ────────────────────────────────────────────────────

export interface InsightCreatedPayload {
  workspaceId: string; insightId: string; title: string; category: string; confidence: number; timestamp: number
}
export interface InsightDismissedPayload {
  workspaceId: string; insightId: string; timestamp: number
}
export interface InsightActedOnPayload {
  workspaceId: string; insightId: string; timestamp: number
}

// ─── Goal payload types ───────────────────────────────────────────────────────

export interface GoalCreatedPayload {
  workspaceId: string; goalId: string; title: string; horizon: string; status: string; timestamp: number
}
export interface GoalUpdatedPayload {
  workspaceId: string; goalId: string; fields: string[]; timestamp: number
}
export interface GoalProgressUpdatedPayload {
  workspaceId: string; goalId: string; progress: number; status: string; timestamp: number
}
export interface GoalCompletedPayload {
  workspaceId: string; goalId: string; completedAt: number; timestamp: number
}

// ─── Agent payload types ──────────────────────────────────────────────────────

export interface AgentRegisteredPayload {
  workspaceId: string; agentId: string; name: string; type: string; timestamp: number
}
export interface AgentHeartbeatPayload {
  workspaceId: string; agentId: string; timestamp: number
}
export interface AgentStatusChangedPayload {
  workspaceId: string; agentId: string; fromStatus: string; toStatus: string; timestamp: number
}

// ─── Business payload types ───────────────────────────────────────────────────

export interface BusinessCreatedPayload {
  workspaceId: string; businessId: string; name: string; timestamp: number
}
export interface BusinessUpdatedPayload {
  workspaceId: string; businessId: string; fields: string[]; timestamp: number
}

// ─── Typed event helper ───────────────────────────────────────────────────────

export interface TypedOpsEvent<T extends EventType> {
  id:          EventId
  type:        T
  workspaceId: WorkspaceId
  payload:     T extends keyof EventPayloadMap ? EventPayloadMap[T] : Record<string, unknown>
  version:     number
  createdAt:   number
  traceId:     string
  correlationId: string
  source:      string
}
