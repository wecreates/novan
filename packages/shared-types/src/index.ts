/**
 * @ops/shared-types — canonical domain types used across all services.
 *
 * Rules:
 *   - No runtime code. Types and enums only.
 *   - No external dependencies.
 *   - All IDs are string (UUID v7).
 *   - All timestamps are Unix ms (number).
 */

// ─── Identity ─────────────────────────────────────────────────────────────────

export type UserId      = string & { __brand: 'UserId' }
export type WorkspaceId = string & { __brand: 'WorkspaceId' }
export type AgentId     = string & { __brand: 'AgentId' }

// ─── Workflow ─────────────────────────────────────────────────────────────────

export type WorkflowId   = string & { __brand: 'WorkflowId' }
export type WorkflowRunId = string & { __brand: 'WorkflowRunId' }
export type StepId       = string & { __brand: 'StepId' }

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting_approval'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'retrying'

export type StepType =
  | 'action'          // generic executable action
  | 'browser'         // Playwright browser automation
  | 'ai_inference'    // AI model call
  | 'memory_read'     // vector memory retrieval
  | 'memory_write'    // memory persistence
  | 'approval'        // human-in-the-loop gate
  | 'condition'       // branching logic
  | 'parallel'        // fan-out execution
  | 'webhook'         // external HTTP call
  | 'scheduled'       // cron-triggered
  | 'http'            // real HTTP request step
  | 'delay'           // timed wait step
  | 'transform'       // data transformation step
  | 'fetch'           // data fetch step
  | 'ai'              // AI step (alias)
  | 'notify'          // notification step
  | 'write'           // data write step

export interface WorkflowDefinition {
  id:          WorkflowId
  workspaceId: WorkspaceId
  name:        string
  description: string | null
  version:     number
  steps:       StepDefinition[]
  triggers:    WorkflowTrigger[]
  retryPolicy: RetryPolicy
  timeout:     number           // ms
  tags:        string[]
  createdAt:   number
  updatedAt:   number
}

export interface StepDefinition {
  id:          StepId
  workflowId:  WorkflowId
  name:        string
  type:        StepType
  config:      Record<string, unknown>
  dependsOn:   StepId[]
  retryPolicy: RetryPolicy | null
  timeout:     number | null    // ms, null = inherit from workflow
  onFailure:   'fail' | 'skip' | 'continue'
}

export interface WorkflowTrigger {
  type:   'manual' | 'cron' | 'event' | 'webhook'
  config: Record<string, unknown>
}

export interface RetryPolicy {
  maxAttempts:     number
  backoffMs:       number
  backoffMultiplier: number
  maxBackoffMs:    number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts:      3,
  backoffMs:        1_000,
  backoffMultiplier: 2,
  maxBackoffMs:     30_000,
}

export interface WorkflowRun {
  id:          WorkflowRunId
  workflowId:  WorkflowId
  workspaceId: WorkspaceId
  status:      WorkflowStatus
  triggeredBy: 'manual' | 'cron' | 'event' | 'webhook'
  triggeredAt: number
  startedAt:   number | null
  completedAt: number | null
  failedAt:    number | null
  errorMessage: string | null
  stepRuns:    StepRun[]
  context:     Record<string, unknown>
  attempt:     number
  parentRunId: WorkflowRunId | null
}

export interface StepRun {
  id:          string
  stepId:      StepId
  runId:       WorkflowRunId
  status:      StepStatus
  startedAt:   number | null
  completedAt: number | null
  output:      Record<string, unknown> | null
  error:       string | null
  attempt:     number
}

// ─── Memory ───────────────────────────────────────────────────────────────────

export type MemoryId   = string & { __brand: 'MemoryId' }
export type MemoryType =
  | 'observation'
  | 'decision'
  | 'lesson'
  | 'goal'
  | 'idea'
  | 'fact'
  | 'strategic'
  | 'operational'

export interface Memory {
  id:          MemoryId
  workspaceId: WorkspaceId
  type:        MemoryType
  content:     string
  summary:     string | null
  embedding:   number[] | null    // pgvector float4[]
  confidence:  number             // 0–1
  tags:        string[]
  source:      string
  sourceRef:   string | null
  createdAt:   number
  updatedAt:   number
  expiresAt:   number | null
}

export interface MemorySearchQuery {
  workspaceId: WorkspaceId
  query:       string
  embedding:   number[] | null
  types:       MemoryType[]
  tags:        string[]
  limit:       number
  minScore:    number
}

export interface MemorySearchResult {
  memory:    Memory
  score:     number
  matchType: 'semantic' | 'keyword' | 'hybrid'
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type EventId = string & { __brand: 'EventId' }

export interface OpsEvent<TPayload = Record<string, unknown>> {
  id:          EventId
  type:        string
  workspaceId: WorkspaceId
  payload:     TPayload
  metadata:    EventMetadata
  createdAt:   number
}

export interface EventMetadata {
  traceId:     string
  causationId: string | null   // event that caused this one
  correlationId: string        // user-facing request ID
  source:      string          // service that emitted
  version:     number          // schema version
}

// ─── Jobs / Queue ─────────────────────────────────────────────────────────────

export type JobId = string & { __brand: 'JobId' }

export type JobPriority = 1 | 2 | 3 | 4 | 5   // 1 = highest

export interface JobDefinition<TData = Record<string, unknown>> {
  id:          JobId
  queue:       QueueName
  type:        string
  data:        TData
  priority:    JobPriority
  delay:       number       // ms before processing
  attempts:    number       // max attempts
  backoff:     { type: 'exponential'; delay: number }
  workspaceId: WorkspaceId
}

export type QueueName =
  | 'workflow'
  | 'browser'
  | 'memory'
  | 'analytics'
  | 'recovery'
  | 'optimization'
  | 'notifications'
  | 'briefing'
  | 'learning'
  | 'autonomous'

// ─── Approval ─────────────────────────────────────────────────────────────────

export type ApprovalId = string & { __brand: 'ApprovalId' }

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

export interface ApprovalRequest {
  id:           ApprovalId
  workspaceId:  WorkspaceId
  runId:        WorkflowRunId
  stepId:       StepId
  requestedBy:  AgentId
  requestedAt:  number
  expiresAt:    number
  status:       ApprovalStatus
  resolvedBy:   UserId | null
  resolvedAt:   number | null
  operationLabel: string
  context:      Record<string, unknown>
  risk:         'low' | 'medium' | 'high' | 'critical'
}

// ─── Observability ────────────────────────────────────────────────────────────

export interface HealthCheck {
  service:   string
  status:    'healthy' | 'degraded' | 'unhealthy'
  latencyMs: number
  details:   Record<string, unknown>
  checkedAt: number
}

export interface MetricPoint {
  name:      string
  value:     number
  labels:    Record<string, string>
  timestamp: number
}

// ─── API contracts ────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: true
  data:    T
  meta?:   ResponseMeta
}

export interface ApiError {
  success:   false
  error:     string
  code:      string
  requestId: string
  details?:  unknown
}

export interface ResponseMeta {
  page?:       number
  pageSize?:   number
  total?:      number
  cursor?:     string
}

export type ApiResult<T> = ApiResponse<T> | ApiError

export interface PaginatedResponse<T> {
  success: boolean
  data:    T[]
  error?:  string
  meta:    { count: number; limit: number; offset: number; hasMore: boolean }
}

// ─── Platform Event (flat shape for external event bus) ───────────────────────

export interface PlatformEvent {
  id:            string
  type:          string
  workspaceId:   string
  payload:       Record<string, unknown>
  source:        string
  version:       number
  traceId:       string
  correlationId: string
  causationId:   string | null
  createdAt:     number
}

export type EventHandler<T = Record<string, unknown>> = (
  event: PlatformEvent & { payload: T }
) => Promise<void> | void

// ─── Trigger types ────────────────────────────────────────────────────────────

export type TriggerType = 'manual' | 'scheduled' | 'event' | 'webhook' | 'api'

// ─── WorkflowStep (lightweight shape for API payloads) ───────────────────────

export interface WorkflowStep {
  id:          string
  name:        string
  type:        string
  config:      Record<string, unknown>
  dependsOn?:  string[]
  retryPolicy?: RetryPolicy
  timeout?:    number
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'busy' | 'offline' | 'error'

export interface AgentCapability {
  name:         string
  version:      string
  description?: string
}

export interface AgentHeartbeat {
  agentId:      string
  workspaceId:  string
  status:       AgentStatus
  currentTask?: string
  timestamp:    number
  metrics?: {
    memoryMb?:   number
    cpuPercent?: number
    activeJobs?: number
  }
}

// ─── Queue job (lightweight payload shape) ────────────────────────────────────

export interface QueueJob<T = Record<string, unknown>> {
  id:        string
  name:      string
  queue:     QueueName
  data:      T
  priority?: number
  delay?:    number
  attempts?: number
}

// ─── Utility types ────────────────────────────────────────────────────────────

export type Nullable<T>          = T | null
export type Optional<T>          = T | undefined
export type NonNullableFields<T> = { [K in keyof T]-?: NonNullable<T[K]> }
export type DeepPartial<T>       = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
