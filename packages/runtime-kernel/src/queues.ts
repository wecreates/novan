/**
 * Queue contracts — canonical job type definitions for all BullMQ queues.
 * Pure types — no runtime dependencies.
 */

export const QUEUE_NAMES = {
  WORKFLOW:  'workflow',
  RECOVERY:  'recovery',
  MEMORY:    'memory',
  BROWSER:   'browser',
  ANALYTICS: 'analytics',
  BRIEFING:  'briefing',
  LEARNING:  'learning',
} as const

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES]

export const QUEUE_CONFIG = {
  LOCK_DURATION_MS:         60_000,
  STALL_INTERVAL_MS:        30_000,
  MAX_STALL_COUNT:          2,
  HEARTBEAT_INTERVAL_MS:    15_000,
  DEFAULT_MAX_ATTEMPTS:     3,
  DEFAULT_BACKOFF_DELAY_MS: 2_000,
} as const

/**
 * Per-queue lock overrides. Long-running job types need a wider lock window
 * than the default 60s to prevent lock expiry mid-execution → duplicate
 * processing under concurrent workers. BullMQ renews the lock every
 * lockDuration/2 while the job is alive, but the *initial* window must be
 * larger than the worst-case single iteration of synchronous work.
 *
 *   - workflow: workflow runs can do heavy step-by-step execution; bounded
 *     by step timeouts, but a single complex step (e.g. nested workflow
 *     dispatch + DB writes) can exceed 60s. 5 min is generous but safe.
 *   - learning: merge_duplicates / dedupe on a 1M-row workspace can run
 *     several minutes before yielding. 5 min covers the worst observed run.
 */
export const QUEUE_LOCK_OVERRIDES: Partial<Record<QueueName, number>> = {
  workflow: 5 * 60_000,
  learning: 5 * 60_000,
}

// --- Workflow queue ---
export interface ExecuteWorkflowJobData { runId: string; workflowId: string; workspaceId: string; traceId: string }
export interface ResumeWorkflowJobData  { runId: string; workspaceId: string; approvalId: string; approved: boolean; resolvedBy: string; traceId?: string }
export interface CancelWorkflowJobData  { runId: string; workspaceId: string; reason: string; traceId?: string }
export type WorkflowQueueJobData = ExecuteWorkflowJobData | ResumeWorkflowJobData | CancelWorkflowJobData

// --- Recovery queue ---
export interface RecoverRunJobData    { runId: string; workspaceId: string; reason: string; traceId?: string }
export interface ScanApprovalsJobData { workspaceId?: string; traceId?: string }
export interface ReplayRunJobData     { runId: string; workspaceId: string; fromStep?: string; traceId?: string }
export type RecoveryQueueJobData = RecoverRunJobData | ScanApprovalsJobData | ReplayRunJobData

// --- Memory queue ---
export interface IndexMemoryJobData  { content: string; workspaceId: string; agentId?: string; metadata?: Record<string, unknown>; traceId?: string }
export interface SearchMemoryJobData { query: string; workspaceId: string; limit?: number; traceId?: string }
export type MemoryQueueJobData = IndexMemoryJobData | SearchMemoryJobData

// --- Browser queue ---
export interface RunAutomationJobData { jobId: string; workspaceId: string; runId?: string; stepId?: string; actions: unknown[]; sessionOpts?: Record<string, unknown>; traceId?: string }
export interface VerifyPageJobData    { jobId: string; workspaceId: string; url: string; label?: string; traceId?: string }
export interface HealthCheckJobData   { url: string; workspaceId: string; timeoutMs?: number; traceId?: string }
export type BrowserQueueJobData = RunAutomationJobData | VerifyPageJobData | HealthCheckJobData

// --- Analytics queue ---
export interface TrackEventJobData    { workspaceId: string; event: string; properties: Record<string, unknown>; userId?: string; traceId?: string }
export interface GenerateReportJobData { workspaceId: string; reportType: string; params: Record<string, unknown>; traceId?: string }
export type AnalyticsQueueJobData = TrackEventJobData | GenerateReportJobData

// Generic metadata included in all job data
// --- Briefing queue ---
export interface GenerateBriefingJobData { workspaceId: string; requestedBy?: string; traceId?: string; windowMs?: number }
export type BriefingQueueJobData = GenerateBriefingJobData

export interface QueueJobMeta { workspaceId: string; traceId?: string; enqueuedAt: number; priority?: number }

// --- Learning queue ---
export interface IngestSignalsJobData    { workspaceId?: string; traceId?: string }
export interface DetectPatternsJobData   { workspaceId?: string; traceId?: string }
export interface ScoreMemoriesJobData    { workspaceId?: string; limit?: number; traceId?: string }
export interface GenerateInsightsJobData { workspaceId?: string; traceId?: string }
export interface RankRecommendationsJobData { workspaceId?: string; traceId?: string }
export interface CompressMemoryJobData   { workspaceId?: string; traceId?: string }
export interface DecayStaleMemoryJobData { workspaceId?: string; traceId?: string }
export interface MergeDuplicatesJobData  { workspaceId?: string; traceId?: string }
export interface UpdateQualityScoresJobData { workspaceId?: string; traceId?: string }
export type LearningQueueJobData =
  | IngestSignalsJobData | DetectPatternsJobData | ScoreMemoriesJobData
  | GenerateInsightsJobData | RankRecommendationsJobData | CompressMemoryJobData
  | DecayStaleMemoryJobData | MergeDuplicatesJobData | UpdateQualityScoresJobData
