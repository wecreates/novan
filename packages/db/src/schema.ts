/**
 * @ops/db — canonical database schema.
 *
 * All tables are workspace-scoped.
 * Timestamps are stored as bigint (Unix ms).
 * Embeddings use pgvector (1536-dim for OpenAI, 768 for Ollama).
 *
 * New tables added here are re-exported from apps/api/src/db/schema.ts
 * for backwards compatibility. Services + workers import from @ops/db directly.
 */
import {
  pgTable, text, integer, bigint, boolean, jsonb,
  real, index, uniqueIndex, pgEnum, vector, primaryKey,
} from 'drizzle-orm/pg-core'

// ─── Enums ────────────────────────────────────────────────────────────────────

export const workflowStatusEnum = pgEnum('workflow_status', [
  'pending', 'running', 'paused', 'completed', 'failed', 'cancelled', 'awaiting_approval',
])

export const stepStatusEnum = pgEnum('step_status', [
  'pending', 'running', 'completed', 'failed', 'skipped', 'retrying',
])

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending', 'approved', 'rejected', 'expired',
])

export const memoryTypeEnum = pgEnum('memory_type', [
  'observation', 'decision', 'lesson', 'goal', 'idea', 'fact', 'strategic', 'operational',
])

export const jobPriorityEnum = pgEnum('job_priority', ['1', '2', '3', '4', '5'])

export const agentStatusEnum = pgEnum('agent_status', [
  'idle', 'running', 'paused', 'error', 'offline',
])

export const opportunityStatusEnum = pgEnum('opportunity_status', [
  'identified', 'evaluating', 'active', 'won', 'lost', 'deferred',
  'accepted', 'rejected', 'stale', 'completed',
])

export const riskSeverityEnum = pgEnum('risk_severity', [
  'low', 'medium', 'high', 'critical',
])

export const goalStatusEnum = pgEnum('goal_status', [
  'draft', 'active', 'paused', 'completed', 'abandoned',
])

// ─── Workspaces ───────────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
  id:        text('id').primaryKey().default('gen_random_uuid()'),
  name:      text('name').notNull(),
  slug:      text('slug').notNull().unique(),
  plan:      text('plan').notNull().default('free'),
  ownerId:   text('owner_id').notNull(),
  settings:  jsonb('settings').notNull().default({}),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── Workflow definitions ─────────────────────────────────────────────────────

export const workflowDefinitions = pgTable('workflow_definitions', {
  id:          text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name:        text('name').notNull(),
  description: text('description'),
  version:     integer('version').notNull().default(1),
  steps:       jsonb('steps').notNull().default([]),
  triggers:    jsonb('triggers').notNull().default([]),
  retryPolicy: jsonb('retry_policy').notNull(),
  timeout:     integer('timeout').notNull().default(300_000),
  tags:        text('tags').array().notNull().default([]),
  isActive:    boolean('is_active').notNull().default(true),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('workflow_def_workspace_idx').on(t.workspaceId),
  index('workflow_def_tags_idx').on(t.tags),
])

// ─── Workflow runs ────────────────────────────────────────────────────────────

export const workflowRuns = pgTable('workflow_runs', {
  id:              text('id').primaryKey().default('gen_random_uuid()'),
  workflowId:      text('workflow_id').notNull().references(() => workflowDefinitions.id),
  workspaceId:     text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  status:          workflowStatusEnum('status').notNull().default('pending'),
  triggeredBy:     text('triggered_by').notNull(),
  triggeredAt:     bigint('triggered_at', { mode: 'number' }).notNull(),
  startedAt:       bigint('started_at', { mode: 'number' }),
  completedAt:     bigint('completed_at', { mode: 'number' }),
  failedAt:        bigint('failed_at', { mode: 'number' }),
  errorMessage:    text('error_message'),
  context:         jsonb('context').notNull().default({}),
  attempt:         integer('attempt').notNull().default(1),
  parentRunId:     text('parent_run_id'),
  checkpointAt:    bigint('checkpoint_at', { mode: 'number' }),
  checkpointState: jsonb('checkpoint_state'),
  traceId:         text('trace_id').notNull(),
}, (t) => [
  index('workflow_run_workspace_idx').on(t.workspaceId),
  index('workflow_run_status_idx').on(t.status),
  index('workflow_run_triggered_idx').on(t.triggeredAt),
])

// ─── Step runs ────────────────────────────────────────────────────────────────

export const stepRuns = pgTable('step_runs', {
  id:          text('id').primaryKey().default('gen_random_uuid()'),
  runId:       text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepId:      text('step_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  status:      stepStatusEnum('status').notNull().default('pending'),
  startedAt:   bigint('started_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }),
  output:      jsonb('output'),
  error:       text('error'),
  attempt:     integer('attempt').notNull().default(1),
  rollback:    jsonb('rollback'),
}, (t) => [
  index('step_run_run_idx').on(t.runId),
  index('step_run_status_idx').on(t.status),
])

// ─── Approvals ────────────────────────────────────────────────────────────────

export const approvals = pgTable('approvals', {
  id:             text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:    text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  runId:          text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
  stepId:         text('step_id').notNull(),
  requestedBy:    text('requested_by').notNull(),
  requestedAt:    bigint('requested_at', { mode: 'number' }).notNull(),
  expiresAt:      bigint('expires_at', { mode: 'number' }).notNull(),
  status:         approvalStatusEnum('status').notNull().default('pending'),
  resolvedBy:     text('resolved_by'),
  resolvedAt:     bigint('resolved_at', { mode: 'number' }),
  operationLabel: text('operation_label').notNull(),
  context:        jsonb('context').notNull().default({}),
  risk:           text('risk').notNull(),
}, (t) => [
  index('approval_workspace_idx').on(t.workspaceId),
  index('approval_status_idx').on(t.status),
  index('approval_expires_idx').on(t.expiresAt),
])

// ─── Memory ───────────────────────────────────────────────────────────────────

export const memories = pgTable('memories', {
  id:          text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  type:        memoryTypeEnum('type').notNull(),
  content:     text('content').notNull(),
  summary:     text('summary'),
  embedding:   vector('embedding', { dimensions: 1536 }),
  confidence:  real('confidence').notNull().default(1.0),
  tags:        text('tags').array().notNull().default([]),
  source:      text('source').notNull(),
  sourceRef:   text('source_ref'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
  expiresAt:   bigint('expires_at', { mode: 'number' }),
}, (t) => [
  index('memory_workspace_idx').on(t.workspaceId),
  index('memory_type_idx').on(t.type),
  index('memory_tags_idx').on(t.tags),
  index('memory_created_idx').on(t.createdAt),
])

// ─── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable('events', {
  id:            text('id').primaryKey().default('gen_random_uuid()'),
  type:          text('type').notNull(),
  workspaceId:   text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  payload:       jsonb('payload').notNull(),
  traceId:       text('trace_id').notNull(),
  correlationId: text('correlation_id').notNull(),
  causationId:   text('causation_id'),
  source:        text('source').notNull(),
  version:       integer('version').notNull().default(1),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('event_workspace_type_idx').on(t.workspaceId, t.type),
  index('event_trace_idx').on(t.traceId),
  index('event_created_idx').on(t.createdAt),
  // HOT-PATH composite: ~80% of event queries filter (workspace_id, type)
  // AND order by created_at desc. Single-column indexes can't satisfy this
  // without a heap scan after the bitmap match.
  index('event_workspace_type_created_idx').on(t.workspaceId, t.type, t.createdAt),
])

// ─── Recovery log ─────────────────────────────────────────────────────────────

export const recoveryLog = pgTable('recovery_log', {
  id:          text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId: text('workspace_id').notNull(),
  runId:       text('run_id').notNull(),
  strategy:    text('strategy').notNull(),
  reason:      text('reason').notNull(),
  steps:       jsonb('steps').notNull(),
  status:      text('status').notNull(),
  startedAt:   bigint('started_at', { mode: 'number' }).notNull(),
  completedAt: bigint('completed_at', { mode: 'number' }),
  error:       text('error'),
}, (t) => [
  index('recovery_run_idx').on(t.runId),
  index('recovery_workspace_idx').on(t.workspaceId),
])

// ─── Businesses ───────────────────────────────────────────────────────────────

export const businesses = pgTable('businesses', {
  id:          text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name:        text('name').notNull(),
  domain:      text('domain'),
  industry:    text('industry'),
  stage:       text('stage').notNull().default('early'),
  health:      text('health').notNull().default('green'),
  metrics:     jsonb('metrics').notNull().default({}),
  metadata:    jsonb('metadata').notNull().default({}),
  // Migration 0041 — Business DNA (strategic identity + originating brief)
  dna:         jsonb('dna').$type<Record<string, unknown>>().notNull().default({}),
  vision:      text('vision'),
  brief:       text('brief'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('business_workspace_idx').on(t.workspaceId),
])

// ─── Migration 0041 — Business spatial children ──────────────────────

export const businessSystems = pgTable('business_systems', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id').notNull(),
  kind:         text('kind').notNull(),
  layer:        text('layer').notNull(),
  name:         text('name').notNull(),
  summary:      text('summary'),
  status:       text('status').notNull().default('forming'),
  agentSlug:    text('agent_slug'),
  parentId:     text('parent_id'),
  position:     jsonb('position').$type<{ x: number; y: number; z: number } | null>(),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('biz_sys_ws_idx').on(t.workspaceId),
  index('biz_sys_business_idx').on(t.businessId),
  index('biz_sys_kind_idx').on(t.kind),
  index('biz_sys_parent_idx').on(t.parentId),
])

// ─── Agents ───────────────────────────────────────────────────────────────────

export const agents = pgTable('agents', {
  id:           text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name:         text('name').notNull(),
  description:  text('description'),
  type:         text('type').notNull(),
  status:       agentStatusEnum('status').notNull().default('idle'),
  capabilities: text('capabilities').array().notNull().default([]),
  config:       jsonb('config').notNull().default({}),
  lastActiveAt: bigint('last_active_at', { mode: 'number' }),
  heartbeatAt:  bigint('heartbeat_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('agent_workspace_idx').on(t.workspaceId),
  index('agent_status_idx').on(t.status),
])

// ─── Opportunities ────────────────────────────────────────────────────────────

export const opportunities = pgTable('opportunities', {
  id:                  text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:         text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  businessId:          text('business_id').references(() => businesses.id),
  title:               text('title').notNull(),
  description:         text('description'),
  type:                text('type').notNull().default('operational'), // revenue|content|seo|automation|business|operational|strategic
  status:              opportunityStatusEnum('status').notNull().default('identified'),
  priority:            integer('priority').notNull().default(50),
  valuePotential:      real('value_potential'),
  confidence:          real('confidence').notNull().default(0.5),
  category:            text('category').notNull().default('growth'),
  evidence:            jsonb('evidence').notNull().default([]),
  tags:                text('tags').array().notNull().default([]),
  // Scoring inputs
  estimatedROI:        real('estimated_roi'),          // multiplier, e.g. 3.5 = 3.5x return
  estimatedEffort:     text('estimated_effort'),        // low|medium|high|very_high
  riskLevel:           text('risk_level'),              // low|medium|high|critical
  strategicAlignment:  real('strategic_alignment'),     // 0-1
  // Computed composite score (0-1) + breakdown
  score:               real('score'),
  scoreBreakdown:      jsonb('score_breakdown').$type<Record<string, number>>(),
  // Linked entities
  linkedMemoryIds:     text('linked_memory_ids').array().notNull().default([]),
  linkedWorkflowIds:   text('linked_workflow_ids').array().notNull().default([]),
  // Conversion
  convertedRunId:      text('converted_run_id'),
  convertedWorkflowId: text('converted_workflow_id'),
  convertedAt:         bigint('converted_at', { mode: 'number' }),
  // Lifecycle timestamps
  acceptedAt:          bigint('accepted_at', { mode: 'number' }),
  rejectedAt:          bigint('rejected_at', { mode: 'number' }),
  dueDate:             bigint('due_date', { mode: 'number' }),
  closedAt:            bigint('closed_at', { mode: 'number' }),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('opportunity_workspace_idx').on(t.workspaceId),
  index('opportunity_status_idx').on(t.status),
  index('opportunity_priority_idx').on(t.priority),
  index('opportunity_type_idx').on(t.type),
  index('opportunity_score_idx').on(t.score),
])

// ─── Risks ────────────────────────────────────────────────────────────────────

export const risks = pgTable('risks', {
  id:           text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  businessId:   text('business_id').references(() => businesses.id),
  title:        text('title').notNull(),
  description:  text('description'),
  severity:     riskSeverityEnum('severity').notNull().default('medium'),
  probability:  real('probability').notNull().default(0.5),
  impact:       real('impact').notNull().default(0.5),
  riskScore:    real('risk_score').notNull().default(0.25),
  category:     text('category').notNull().default('operational'),
  status:       text('status').notNull().default('open'),
  mitigations:  jsonb('mitigations').notNull().default([]),
  detectedAt:   bigint('detected_at', { mode: 'number' }).notNull(),
  resolvedAt:   bigint('resolved_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('risk_workspace_idx').on(t.workspaceId),
  index('risk_severity_idx').on(t.severity),
  index('risk_score_idx').on(t.riskScore),
])

// ─── Insights ─────────────────────────────────────────────────────────────────

export const insights = pgTable('insights', {
  id:           text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  title:        text('title').notNull(),
  body:         text('body').notNull(),
  category:     text('category').notNull().default('operational'),
  confidence:   real('confidence').notNull().default(0.8),
  source:       text('source').notNull(),
  sourceRef:    text('source_ref'),
  tags:         text('tags').array().notNull().default([]),
  embedding:    vector('embedding', { dimensions: 1536 }),
  dismissed:    boolean('dismissed').notNull().default(false),
  actedOn:      boolean('acted_on').notNull().default(false),
  expiresAt:    bigint('expires_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('insight_workspace_idx').on(t.workspaceId),
  index('insight_category_idx').on(t.category),
  index('insight_created_idx').on(t.createdAt),
])

// ─── Strategic goals ──────────────────────────────────────────────────────────

export const strategicGoals = pgTable('strategic_goals', {
  id:           text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  businessId:   text('business_id').references(() => businesses.id),
  parentGoalId: text('parent_goal_id'),
  title:        text('title').notNull(),
  description:  text('description'),
  status:       goalStatusEnum('status').notNull().default('draft'),
  horizon:      text('horizon').notNull().default('quarter'),
  targetDate:   bigint('target_date', { mode: 'number' }),
  progress:     real('progress').notNull().default(0),
  keyResults:   jsonb('key_results').notNull().default([]),
  owners:       text('owners').array().notNull().default([]),
  tags:         text('tags').array().notNull().default([]),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('goal_workspace_idx').on(t.workspaceId),
  index('goal_status_idx').on(t.status),
  index('goal_horizon_idx').on(t.horizon),
])

// ─── AI usage ─────────────────────────────────────────────────────────────────

export const aiUsage = pgTable('ai_usage', {
  id:           text('id').primaryKey().default('gen_random_uuid()'),
  workspaceId:  text('workspace_id').notNull(),
  provider:     text('provider').notNull(),
  model:        text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd:      real('cost_usd').notNull(),
  latencyMs:    integer('latency_ms').notNull(),
  cached:       boolean('cached').notNull().default(false),
  taskType:     text('task_type').notNull(),
  timestamp:    bigint('timestamp', { mode: 'number' }).notNull(),
  // Attribution (nullable; callers may populate for FACT-level per-trace/per-workflow cost rollups)
  traceId:       text('trace_id'),
  workflowRunId: text('workflow_run_id'),
}, (t) => [
  index('ai_usage_workspace_idx').on(t.workspaceId),
  index('ai_usage_timestamp_idx').on(t.timestamp),
  index('ai_usage_trace_idx').on(t.traceId),
  index('ai_usage_workflow_idx').on(t.workflowRunId),
  // HOT-PATH composite: billing/analytics rollups always filter
  // (workspace_id, timestamp >= X). Two separate indexes only bitmap-AND
  // under right stats; composite is reliable.
  index('ai_usage_workspace_ts_idx').on(t.workspaceId, t.timestamp),
])

// ─── Dead-letter jobs ─────────────────────────────────────────────────────────

export const deadLetterJobs = pgTable('dead_letter_jobs', {
  id:             text('id').primaryKey(),
  queueName:      text('queue_name').notNull(),
  jobId:          text('job_id').notNull(),
  jobName:        text('job_name').notNull(),
  workspaceId:    text('workspace_id').notNull(),
  payload:        jsonb('payload').$type<Record<string, unknown>>().notNull(),
  error:          text('error').notNull(),
  attempts:       integer('attempts').notNull().default(0),
  workerId:       text('worker_id').notNull(),
  traceId:        text('trace_id'),
  firstFailedAt:  bigint('first_failed_at', { mode: 'number' }).notNull(),
  deadLetteredAt: bigint('dead_lettered_at', { mode: 'number' }).notNull(),
  replayedAt:     bigint('replayed_at', { mode: 'number' }),
  replayedBy:     text('replayed_by'),
  replayRunId:    text('replay_run_id'),
}, (t) => [
  index('dlq_workspace_idx').on(t.workspaceId),
  index('dlq_queue_idx').on(t.queueName),
  index('dlq_dead_lettered_at_idx').on(t.deadLetteredAt),
])

// ─── Observability: Event traces ──────────────────────────────────────────────

export const eventTraces = pgTable('event_traces', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  traceId:     text('trace_id').notNull(),
  eventId:     text('event_id').notNull(),
  eventType:   text('event_type').notNull(),
  source:      text('source').notNull(),
  payload:     jsonb('payload').$type<Record<string, unknown>>().notNull(),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('et_trace_idx').on(t.traceId),
  index('et_workspace_idx').on(t.workspaceId),
  index('et_created_idx').on(t.createdAt),
])

// ─── Observability: Workflow traces ──────────────────────────────────────────

export const workflowTraces = pgTable('workflow_traces', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  traceId:      text('trace_id').notNull(),
  runId:        text('run_id').notNull(),
  workflowId:   text('workflow_id').notNull(),
  status:       text('status').notNull(),
  triggeredBy:  text('triggered_by').notNull(),
  startedAt:    bigint('started_at', { mode: 'number' }),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  failedAt:     bigint('failed_at', { mode: 'number' }),
  durationMs:   integer('duration_ms'),
  stepCount:    integer('step_count').notNull().default(0),
  errorMessage: text('error_message'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('wt_trace_idx').on(t.traceId),
  index('wt_run_idx').on(t.runId),
  index('wt_workspace_idx').on(t.workspaceId),
])

// ─── Observability: Task traces ───────────────────────────────────────────────

export const taskTraces = pgTable('task_traces', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  traceId:     text('trace_id').notNull(),
  runId:       text('run_id').notNull(),
  stepId:      text('step_id').notNull(),
  stepType:    text('step_type').notNull(),
  status:      text('status').notNull(),
  attempt:     integer('attempt').notNull().default(1),
  startedAt:   bigint('started_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }),
  durationMs:  integer('duration_ms'),
  output:      jsonb('output').$type<Record<string, unknown>>(),
  error:       text('error'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('tt_trace_idx').on(t.traceId),
  index('tt_run_idx').on(t.runId),
  index('tt_workspace_idx').on(t.workspaceId),
])

// ─── Observability: Approval traces ──────────────────────────────────────────

export const approvalTraces = pgTable('approval_traces', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  traceId:        text('trace_id').notNull(),
  approvalId:     text('approval_id').notNull(),
  runId:          text('run_id').notNull(),
  stepId:         text('step_id').notNull(),
  status:         text('status').notNull(),
  requestedBy:    text('requested_by').notNull(),
  resolvedBy:     text('resolved_by'),
  requestedAt:    bigint('requested_at', { mode: 'number' }).notNull(),
  resolvedAt:     bigint('resolved_at', { mode: 'number' }),
  expiresAt:      bigint('expires_at', { mode: 'number' }).notNull(),
  operationLabel: text('operation_label').notNull(),
  risk:           text('risk').notNull(),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('at_trace_idx').on(t.traceId),
  index('at_approval_idx').on(t.approvalId),
  index('at_workspace_idx').on(t.workspaceId),
])

// ─── Observability: Policy traces ────────────────────────────────────────────

export const policyTraces = pgTable('policy_traces', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  traceId:     text('trace_id').notNull(),
  policyId:    text('policy_id').notNull(),
  policyName:  text('policy_name').notNull(),
  action:      text('action').notNull(),
  verdict:     text('verdict').notNull(),
  riskLevel:   text('risk_level').notNull(),
  agentId:     text('agent_id'),
  checkedAt:   bigint('checked_at', { mode: 'number' }).notNull(),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pt_trace_idx').on(t.traceId),
  index('pt_workspace_idx').on(t.workspaceId),
  index('pt_verdict_idx').on(t.verdict),
])

// ─── Observability: Worker traces ────────────────────────────────────────────

export const workerTraces = pgTable('worker_traces', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id'),
  traceId:       text('trace_id').notNull(),
  workerId:      text('worker_id').notNull(),
  workerName:    text('worker_name').notNull(),
  queueName:     text('queue_name').notNull(),
  event:         text('event').notNull(),
  heapUsedMb:    real('heap_used_mb'),
  rssMemMb:      real('rss_mem_mb'),
  activeJobs:    integer('active_jobs'),
  processedJobs: integer('processed_jobs'),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('wort_trace_idx').on(t.traceId),
  index('wort_worker_idx').on(t.workerId),
  index('wort_queue_idx').on(t.queueName),
])

// ─── Observability: Queue traces ─────────────────────────────────────────────

export const queueTraces = pgTable('queue_traces', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id'),
  traceId:     text('trace_id').notNull(),
  queueName:   text('queue_name').notNull(),
  jobId:       text('job_id').notNull(),
  jobName:     text('job_name').notNull(),
  event:       text('event').notNull(),
  durationMs:  integer('duration_ms'),
  attempt:     integer('attempt'),
  error:       text('error'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('qt_trace_idx').on(t.traceId),
  index('qt_queue_idx').on(t.queueName),
  index('qt_job_idx').on(t.jobId),
])

// ─── Browser sessions ─────────────────────────────────────────────────────────

export const browserSessions = pgTable('browser_sessions', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  jobId:          text('job_id').notNull(),
  runId:          text('run_id'),
  stepId:         text('step_id'),
  traceId:        text('trace_id').notNull(),
  url:            text('url').notNull(),
  status:         text('status').notNull().default('active'),
  pageTitle:      text('page_title'),
  pageText:       text('page_text'),
  screenshotPath: text('screenshot_path'),
  errorMessage:   text('error_message'),
  durationMs:     integer('duration_ms'),
  startedAt:      bigint('started_at', { mode: 'number' }).notNull(),
  completedAt:    bigint('completed_at', { mode: 'number' }),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('bsess_workspace_idx').on(t.workspaceId),
  index('bsess_job_idx').on(t.jobId),
  index('bsess_started_idx').on(t.startedAt),
])

export const browserActions = pgTable('browser_actions', {
  id:             text('id').primaryKey(),
  sessionId:      text('session_id').notNull().references(() => browserSessions.id, { onDelete: 'cascade' }),
  workspaceId:    text('workspace_id').notNull(),
  actionType:     text('action_type').notNull(),
  actionInput:    jsonb('action_input').notNull().default({}),
  success:        boolean('success').notNull().default(false),
  output:         jsonb('output'),
  error:          text('error'),
  screenshotPath: text('screenshot_path'),
  durationMs:     integer('duration_ms'),
  executedAt:     bigint('executed_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('bact_session_idx').on(t.sessionId),
  index('bact_workspace_idx').on(t.workspaceId),
])

// ─── Observability: Failure lineages ─────────────────────────────────────────

export const failureLineages = pgTable('failure_lineages', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  runId:             text('run_id').notNull(),
  traceId:           text('trace_id').notNull(),
  rootCause:         text('root_cause'),
  failureChain:      jsonb('failure_chain').$type<Array<{ eventId: string; eventType: string; timestamp: number; message?: string }>>().notNull(),
  affectedSteps:     text('affected_steps').array().notNull().default([]),
  recoveryAttempts:  integer('recovery_attempts').notNull().default(0),
  resolved:          boolean('resolved').notNull().default(false),
  resolvedAt:        bigint('resolved_at', { mode: 'number' }),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('fl_run_idx').on(t.runId),
  index('fl_trace_idx').on(t.traceId),
  index('fl_workspace_idx').on(t.workspaceId),
])

// ─── Snapshots ────────────────────────────────────────────────────────────────

export const snapshots = pgTable('snapshots', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId:       text('run_id').notNull(),
  stepId:      text('step_id'),
  traceId:     text('trace_id').notNull(),
  status:      text('status').notNull().default('active'),
  description: text('description'),
  itemCount:   integer('item_count').notNull().default(0),
  sizeBytes:   integer('size_bytes').notNull().default(0),
  expiresAt:   bigint('expires_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('snap_run_idx').on(t.runId),
  index('snap_workspace_idx').on(t.workspaceId),
  index('snap_trace_idx').on(t.traceId),
])

// ─── Snapshot items ───────────────────────────────────────────────────────────

export const snapshotItems = pgTable('snapshot_items', {
  id:          text('id').primaryKey(),
  snapshotId:  text('snapshot_id').notNull().references(() => snapshots.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  itemType:    text('item_type').notNull(),
  entityType:  text('entity_type').notNull(),
  entityId:    text('entity_id').notNull(),
  beforeState: jsonb('before_state').$type<Record<string, unknown>>().notNull(),
  metadata:    jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('si_snapshot_idx').on(t.snapshotId),
  index('si_entity_idx').on(t.entityType, t.entityId),
])

// ─── Rollback requests ────────────────────────────────────────────────────────

export const rollbackRequests = pgTable('rollback_requests', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  runId:       text('run_id').notNull(),
  snapshotId:  text('snapshot_id'),
  traceId:     text('trace_id').notNull(),
  status:      text('status').notNull().default('pending'),
  reason:      text('reason').notNull(),
  requestedBy: text('requested_by').notNull(),
  startedAt:   bigint('started_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rr_run_idx').on(t.runId),
  index('rr_workspace_idx').on(t.workspaceId),
  index('rr_status_idx').on(t.status),
])

// ─── Rollback results ─────────────────────────────────────────────────────────

export const rollbackResults = pgTable('rollback_results', {
  id:          text('id').primaryKey(),
  requestId:   text('request_id').notNull().references(() => rollbackRequests.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  itemId:      text('item_id').notNull().references(() => snapshotItems.id),
  status:      text('status').notNull(),
  error:       text('error'),
  restoredAt:  bigint('restored_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rb_request_idx').on(t.requestId),
  index('rb_workspace_idx').on(t.workspaceId),
])

// ─── Recovery checkpoints ─────────────────────────────────────────────────────

export const recoveryCheckpoints = pgTable('recovery_checkpoints', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  runId:          text('run_id').notNull(),
  stepId:         text('step_id').notNull(),
  traceId:        text('trace_id').notNull(),
  completedSteps: text('completed_steps').array().notNull().default([]),
  state:          jsonb('state').$type<Record<string, unknown>>().notNull(),
  snapshotId:     text('snapshot_id'),
  restoredAt:     bigint('restored_at', { mode: 'number' }),
  restoredBy:     text('restored_by'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rcp_run_idx').on(t.runId),
  index('rcp_workspace_idx').on(t.workspaceId),
])

// ─── Executive briefings ──────────────────────────────────────────────────────

export const briefings = pgTable('briefings', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  status:       text('status').notNull().default('generating'),   // generating | ready | failed
  requestedBy:  text('requested_by').notNull().default('system'),
  traceId:      text('trace_id').notNull(),
  windowMs:     bigint('window_ms', { mode: 'number' }).notNull().default(86_400_000), // lookback window
  // Aggregated section summaries (quick read without loading all items)
  summary:      text('summary'),
  errorMessage: text('error_message'),
  generatedAt:  bigint('generated_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('briefing_workspace_idx').on(t.workspaceId),
  index('briefing_status_idx').on(t.status),
  index('briefing_created_idx').on(t.createdAt),
])

export const briefingItems = pgTable('briefing_items', {
  id:           text('id').primaryKey(),
  briefingId:   text('briefing_id').notNull().references(() => briefings.id, { onDelete: 'cascade' }),
  workspaceId:  text('workspace_id').notNull(),
  section:      text('section').notNull(),    // top_priorities | blocked_workflows | risks | opportunities | recovery | next_actions
  title:        text('title').notNull(),
  body:         text('body').notNull(),
  confidence:   real('confidence').notNull().default(0.8),
  isLowConfidence: boolean('is_low_confidence').notNull().default(false),
  source:       text('source').notNull(),     // workflow_runs | memories | risks | opportunities | events | insights
  sourceRef:    text('source_ref'),           // entity ID that sourced this item
  sourceLabel:  text('source_label'),         // human-readable source description
  // Task conversion
  converted:    boolean('converted').notNull().default(false),
  convertedAt:  bigint('converted_at', { mode: 'number' }),
  convertedRunId: text('converted_run_id'),   // workflow run created from this item
  convertedWorkflowId: text('converted_workflow_id'),
  priority:     integer('priority').notNull().default(50),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('bi_briefing_idx').on(t.briefingId),
  index('bi_workspace_idx').on(t.workspaceId),
  index('bi_section_idx').on(t.section),
  // Composite for the common fetch pattern (ws + section + priority sort).
  // Migration 0048. Without it Postgres bitmap-AND the workspace + section
  // single-column indexes which is 2-3× slower at 500+ rows/workspace.
  index('bi_workspace_section_idx').on(t.workspaceId, t.section),
  index('bi_converted_idx').on(t.converted),
])

// ─── API Tokens ───────────────────────────────────────────────────────────────

export const apiTokens = pgTable('api_tokens', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name:        text('name').notNull(),
  tokenHash:   text('token_hash').notNull().unique(),   // SHA-256 of the token
  prefix:      text('prefix').notNull(),                 // first 8 chars for display
  scopes:      text('scopes').array().notNull().default(['read', 'write']),
  lastUsedAt:  bigint('last_used_at', { mode: 'number' }),
  expiresAt:   bigint('expires_at', { mode: 'number' }),
  revokedAt:   bigint('revoked_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('token_hash_idx').on(t.tokenHash),
  index('token_workspace_idx').on(t.workspaceId),
])

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  title:       text('title').notNull(),
  body:        text('body').notNull(),
  type:        text('type').notNull().default('info'),       // info | warning | error | success
  category:    text('category').notNull().default('system'), // system | workflow | approval | risk | opportunity | goal
  read:        boolean('read').notNull().default(false),
  dismissed:   boolean('dismissed').notNull().default(false),
  sourceType:  text('source_type'),   // e.g. 'workflow_run', 'opportunity', 'risk'
  sourceId:    text('source_id'),
  actionUrl:   text('action_url'),
  expiresAt:   bigint('expires_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('notif_workspace_idx').on(t.workspaceId),
  index('notif_read_idx').on(t.read),
  index('notif_created_idx').on(t.createdAt),
])

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const webhooks = pgTable('webhooks', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name:        text('name').notNull(),
  secret:      text('secret').notNull(),      // HMAC secret for signature verification
  events:      text('events').array().notNull().default([]),  // event type filters, empty = all
  targetUrl:   text('target_url'),             // for outbound webhooks (future)
  workflowId:  text('workflow_id'),            // if set, incoming webhook triggers this workflow
  active:      boolean('active').notNull().default(true),
  callCount:   integer('call_count').notNull().default(0),
  lastCalledAt: bigint('last_called_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('webhook_workspace_idx').on(t.workspaceId),
  index('webhook_active_idx').on(t.active),
])

// ─── Scheduled triggers ───────────────────────────────────────────────────────

export const scheduledTriggers = pgTable('scheduled_triggers', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  workflowId: text('workflow_id').notNull(),
  cronExpression: text('cron_expression').notNull(), // e.g. "0 9 * * 1" = every Monday 9am
  timezone: text('timezone').notNull().default('UTC'),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: bigint('last_run_at', { mode: 'number' }),
  nextRunAt: bigint('next_run_at', { mode: 'number' }),
  lastRunStatus: text('last_run_status'), // 'success' | 'failed' | 'skipped'
  runCount: integer('run_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  wsIdx: index('scheduled_triggers_ws_idx').on(t.workspaceId),
  enabledIdx: index('scheduled_triggers_enabled_idx').on(t.enabled, t.nextRunAt),
}))

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id:          text('id').primaryKey(),
  webhookId:   text('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  eventType:   text('event_type').notNull(),
  payload:     jsonb('payload').notNull().default({}),
  status:      text('status').notNull().default('received'),   // received | processed | failed | triggered
  runId:       text('run_id'),    // workflow run triggered
  error:       text('error'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('wdel_webhook_idx').on(t.webhookId),
  index('wdel_workspace_idx').on(t.workspaceId),
])

// ─── Learning Runtime ──────────────────────────────────────────────────────────
// All tables are workspace-scoped. Evidence is always required.
// Confidence: 0.0–1.0. Status fields control review/approval flow.

export const learningSignals = pgTable('learning_signals', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  source:          text('source').notNull(), // workflow_success|workflow_failure|task_duration|approval|dlq|recovery|memory_retrieval|briefing_usage|browser_outcome|ai_provider|user_correction|feedback|manual
  sourceEventId:   text('source_event_id'),
  sourceWorkflowId: text('source_workflow_id'),
  sourceRunId:     text('source_run_id'),
  sourceMemoryId:  text('source_memory_id'),
  signal:          text('signal').notNull(),   // short descriptor e.g. "workflow_failed"
  evidence:        jsonb('evidence').notNull().default({}), // structured evidence payload
  confidence:      real('confidence').notNull().default(1.0),
  status:          text('status').notNull().default('new'), // new|scored|pattern_candidate|archived
  reviewRequired:  boolean('review_required').notNull().default(false),
  patternId:       text('pattern_id'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ls_workspace_idx').on(t.workspaceId),
  index('ls_source_idx').on(t.source),
  index('ls_status_idx').on(t.status),
  index('ls_created_idx').on(t.createdAt),
])

export const learningPatterns = pgTable('learning_patterns', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  patternType:  text('pattern_type').notNull(), // repeated_failure|approval_friction|recurring_bottleneck|high_performing_workflow|slow_route|recovery_path|content_pattern|abandoned_workflow|duplicate_task|stale_context
  title:        text('title').notNull(),
  description:  text('description').notNull(),
  occurrences:  integer('occurrences').notNull().default(1),
  confidence:   real('confidence').notNull(),
  evidence:     jsonb('evidence').notNull().default([]),  // array of signal_ids + summaries
  affectedIds:  jsonb('affected_ids').notNull().default([]),  // workflow/run/memory ids
  status:       text('status').notNull().default('active'), // active|resolved|ignored|superseded
  firstSeenAt:  bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:   bigint('last_seen_at', { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('lp_workspace_idx').on(t.workspaceId),
  index('lp_type_idx').on(t.patternType),
  index('lp_status_idx').on(t.status),
  index('lp_confidence_idx').on(t.confidence),
])

export const learningInsights = pgTable('learning_insights', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  title:          text('title').notNull(),
  body:           text('body').notNull(),
  category:       text('category').notNull(), // operational|content|revenue|performance|reliability|security
  confidence:     real('confidence').notNull(),
  evidence:       jsonb('evidence').notNull().default([]),  // array of pattern_ids + signal summaries
  actionRequired: boolean('action_required').notNull().default(false),
  approved:       boolean('approved'),  // null=pending, true=approved, false=rejected
  approvedBy:     text('approved_by'),
  approvedAt:     bigint('approved_at', { mode: 'number' }),
  patternId:      text('pattern_id'),
  embedding:      vector('embedding', { dimensions: 768 }),
  status:         text('status').notNull().default('pending_review'), // pending_review|approved|rejected|executed|archived
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('li_workspace_idx').on(t.workspaceId),
  index('li_category_idx').on(t.category),
  index('li_status_idx').on(t.status),
  index('li_confidence_idx').on(t.confidence),
])

export const learningFeedback = pgTable('learning_feedback', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  recommendationId: text('recommendation_id').notNull(),
  insightId:        text('insight_id'),
  action:           text('action').notNull(), // accepted|rejected|ignored|executed
  outcome:          text('outcome'), // successful|failed|partial|pending
  outcomeNotes:     text('outcome_notes'),
  userId:           text('user_id'),
  deltaMetric:      real('delta_metric'),   // measurable change after execution
  metricName:       text('metric_name'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('lf_workspace_idx').on(t.workspaceId),
  index('lf_rec_idx').on(t.recommendationId),
  index('lf_action_idx').on(t.action),
])

export const learningScores = pgTable('learning_scores', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  entityType:  text('entity_type').notNull(),  // workflow|memory|provider|worker|route
  entityId:    text('entity_id').notNull(),
  scoreType:   text('score_type').notNull(),   // quality|reliability|performance|relevance
  scoreValue:  real('score_value').notNull(),
  history:     jsonb('history').notNull().default([]), // [{ts, value, reason}]
  sampleCount: integer('sample_count').notNull().default(1),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('lsc_workspace_idx').on(t.workspaceId),
  index('lsc_entity_idx').on(t.entityType, t.entityId),
  index('lsc_type_idx').on(t.scoreType),
])

export const memoryEmbeddings = pgTable('memory_embeddings', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  memoryId:     text('memory_id').notNull(),
  chunkIndex:   integer('chunk_index').notNull().default(0),
  chunkText:    text('chunk_text').notNull(),
  embedding:    vector('embedding', { dimensions: 768 }),
  embeddingModel: text('embedding_model').notNull().default('nomic-embed-text'),
  isStale:      boolean('is_stale').notNull().default(false),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('me_workspace_idx').on(t.workspaceId),
  index('me_memory_idx').on(t.memoryId),
  index('me_stale_idx').on(t.isStale),
])

export const memoryClusters = pgTable('memory_clusters', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  label:          text('label').notNull(),
  description:    text('description'),
  memberMemoryIds: jsonb('member_memory_ids').notNull().default([]),
  centroid:       vector('centroid', { dimensions: 768 }),
  memberCount:    integer('member_count').notNull().default(0),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('mc_workspace_idx').on(t.workspaceId),
])

export const retrievalLogs = pgTable('retrieval_logs', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  query:           text('query').notNull(),
  queryEmbedding:  vector('query_embedding', { dimensions: 768 }),
  memoryIdsReturned: jsonb('memory_ids_returned').notNull().default([]),
  scores:          jsonb('scores').notNull().default([]),
  retrievalType:   text('retrieval_type').notNull().default('hybrid'), // semantic|keyword|hybrid
  latencyMs:       integer('latency_ms'),
  wasUsed:         boolean('was_used').notNull().default(false),
  usedByRunId:     text('used_by_run_id'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rl_workspace_idx').on(t.workspaceId),
  index('rl_used_idx').on(t.wasUsed),
  index('rl_created_idx').on(t.createdAt),
])

export const recommendationOutcomes = pgTable('recommendation_outcomes', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  recommendationId: text('recommendation_id').notNull(),
  insightId:        text('insight_id'),
  outcome:          text('outcome').notNull(), // accepted|rejected|ignored|executed|successful|failed
  deltaMetric:      real('delta_metric'),
  metricName:       text('metric_name'),
  notes:            text('notes'),
  executedBy:       text('executed_by'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ro_workspace_idx').on(t.workspaceId),
  index('ro_rec_idx').on(t.recommendationId),
])

export const modelQualityScores = pgTable('model_quality_scores', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  provider:    text('provider').notNull(),   // ollama|openai|anthropic|local
  model:       text('model').notNull(),
  taskType:    text('task_type').notNull(),  // embedding|completion|classification|summarization
  scoreValue:  real('score_value').notNull(),
  sampleCount: integer('sample_count').notNull().default(1),
  latencyP50:  real('latency_p50'),
  latencyP99:  real('latency_p99'),
  errorRate:   real('error_rate').notNull().default(0),
  history:     jsonb('history').notNull().default([]),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('mqs_workspace_idx').on(t.workspaceId),
  index('mqs_provider_idx').on(t.provider, t.model),
  index('mqs_task_idx').on(t.taskType),
])

// ─── Remote Compute Router ────────────────────────────────────────────────────
// Persistent provider registry: API keys (AES-256-GCM encrypted), remote
// endpoints, health log, failure log, and per-workspace budget state.

/** Per-workspace configuration for an API provider (Groq, OpenAI, etc.) */
export const providerConfigs = pgTable('provider_configs', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  providerId:       text('provider_id').notNull(), // groq|openrouter|openai|anthropic|gemini|ollama_remote
  label:            text('label').notNull(),
  apiKeyEncrypted:  text('api_key_encrypted'),     // AES-256-GCM ciphertext (hex)
  apiKeyIv:         text('api_key_iv'),             // AES-256-GCM nonce (hex)
  enabled:          boolean('enabled').notNull().default(true),
  priority:         integer('priority').notNull().default(50), // lower = preferred
  maxCostPerReqUsd: real('max_cost_per_req_usd'),
  notes:            text('notes'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pc_workspace_idx').on(t.workspaceId),
  index('pc_provider_idx').on(t.providerId),
  index('pc_enabled_idx').on(t.enabled),
])

/** Private remote endpoints (self-hosted Ollama, vLLM, RunPod, etc.) */
export const remoteEndpoints = pgTable('remote_endpoints', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  name:            text('name').notNull(),
  type:            text('type').notNull(), // ollama|vllm|localai|tgi|openai_compat|runpod|vastai|lambda
  baseUrl:         text('base_url').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  apiKeyIv:        text('api_key_iv'),
  // Custom auth headers stored encrypted (JSON object: Record<string,string>)
  customHeadersEncrypted: text('custom_headers_encrypted'),
  customHeadersIv:        text('custom_headers_iv'),
  modelIds:        text('model_ids').array().notNull().default([]), // models available on this endpoint
  // Capacity / pricing
  maxContextTokens: integer('max_context_tokens').notNull().default(8192),
  promptPer1kUsd:   real('prompt_per_1k_usd').notNull().default(0),   // 0 = self-hosted / free
  outputPer1kUsd:   real('output_per_1k_usd').notNull().default(0),
  timeoutMs:        integer('timeout_ms').notNull().default(60_000),    // request timeout
  enabled:         boolean('enabled').notNull().default(true),
  paused:          boolean('paused').notNull().default(false),          // soft-disable without removing
  priority:        integer('priority').notNull().default(10), // private preferred over API
  healthStatus:    text('health_status').notNull().default('unknown'), // healthy|degraded|down|unknown
  lastHealthCheck: bigint('last_health_check', { mode: 'number' }),
  latencyMs:       real('latency_ms'),
  // Model discovery
  modelCount:           integer('model_count').notNull().default(0),
  lastModelDiscovery:   bigint('last_model_discovery', { mode: 'number' }),
  lastDiscoveryError:   text('last_discovery_error'),
  notes:           text('notes'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('re_workspace_idx').on(t.workspaceId),
  index('re_enabled_idx').on(t.enabled),
  index('re_health_idx').on(t.healthStatus),
  index('re_priority_idx').on(t.priority),
])

/** Per-request usage log for remote endpoints */
export const endpointUsageLogs = pgTable('endpoint_usage_logs', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  endpointId:   text('endpoint_id').notNull(),
  model:        text('model').notNull(),
  taskType:     text('task_type').notNull(),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd:      real('cost_usd').notNull().default(0),
  latencyMs:    integer('latency_ms').notNull().default(0),
  streamed:     boolean('streamed').notNull().default(false),
  success:      boolean('success').notNull().default(true),
  errorMessage: text('error_message'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('eul_workspace_idx').on(t.workspaceId),
  index('eul_endpoint_idx').on(t.endpointId),
  index('eul_created_idx').on(t.createdAt),
])

/** Time-series health check results */
export const providerHealthLog = pgTable('provider_health_log', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  providerId:  text('provider_id').notNull(),   // provider id or endpoint id
  sourceType:  text('source_type').notNull().default('provider'), // provider|endpoint
  status:      text('status').notNull(),         // healthy|degraded|down
  latencyMs:   real('latency_ms'),
  errorRate:   real('error_rate').notNull().default(0),
  checkedAt:   bigint('checked_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('phl_workspace_idx').on(t.workspaceId),
  index('phl_provider_idx').on(t.providerId),
  index('phl_checked_idx').on(t.checkedAt),
])

/** Per-request failure log for debugging and routing intelligence */
export const providerFailures = pgTable('provider_failures', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  providerId:         text('provider_id').notNull(),
  endpointId:         text('endpoint_id'),             // set if remote endpoint
  taskType:           text('task_type').notNull(),
  model:              text('model').notNull(),
  errorType:          text('error_type').notNull(),    // rate_limit|auth|timeout|server_error|budget_blocked|unknown
  errorMessage:       text('error_message').notNull(),
  fallbackUsed:       boolean('fallback_used').notNull().default(false),
  fallbackProviderId: text('fallback_provider_id'),
  costUsd:            real('cost_usd').notNull().default(0),
  latencyMs:          real('latency_ms'),
  createdAt:          bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pf_workspace_idx').on(t.workspaceId),
  index('pf_provider_idx').on(t.providerId),
  index('pf_created_idx').on(t.createdAt),
  index('pf_error_idx').on(t.errorType),
])

/** Per-workspace budget state (spend tracking + limits) */
export const providerBudgets = pgTable('provider_budgets', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull().unique(),
  dailyLimitUsd:    real('daily_limit_usd').notNull().default(10),
  weeklyLimitUsd:   real('weekly_limit_usd').notNull().default(0),
  monthlyLimitUsd:  real('monthly_limit_usd').notNull().default(100),
  dailySpendUsd:    real('daily_spend_usd').notNull().default(0),
  weeklySpendUsd:   real('weekly_spend_usd').notNull().default(0),
  monthlySpendUsd:  real('monthly_spend_usd').notNull().default(0),
  dailyResetAt:     bigint('daily_reset_at', { mode: 'number' }).notNull(),
  weeklyResetAt:    bigint('weekly_reset_at', { mode: 'number' }),
  monthlyResetAt:   bigint('monthly_reset_at', { mode: 'number' }).notNull(),
  alertThreshold:   real('alert_threshold').notNull().default(0.8),
  maxPerJobUsd:     real('max_per_job_usd').notNull().default(0),
  maxBrowserSessionSecs: integer('max_browser_session_secs').notNull().default(0),
  maxAiRequestSecs: integer('max_ai_request_secs').notNull().default(0),
  maxRetries:       integer('max_retries').notNull().default(10),
  maxConcurrentRemote: integer('max_concurrent_remote').notNull().default(5),
  hardStop:         boolean('hard_stop').notNull().default(false),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pb_workspace_idx').on(t.workspaceId),
])

/** Kill switches — per-workspace per-type circuit breakers */
export const killSwitches = pgTable('kill_switches', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  switchType:  text('switch_type').notNull(), // remote_worker | provider | browser_job | ai_request
  enabled:     boolean('enabled').notNull().default(false),
  reason:      text('reason'),
  enabledBy:   text('enabled_by'),
  enabledAt:   bigint('enabled_at', { mode: 'number' }),
  disabledAt:  bigint('disabled_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('ks_workspace_type_idx').on(t.workspaceId, t.switchType),
  index('ks_workspace_idx').on(t.workspaceId),
])

/** Runaway job log — jobs detected and stopped for exceeding limits */
export const runawayJobs = pgTable('runaway_jobs', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  jobId:       text('job_id').notNull(),
  jobType:     text('job_type').notNull(), // ai | browser | remote | workflow
  endpointId:  text('endpoint_id'),
  providerId:  text('provider_id'),
  costUsd:     real('cost_usd').notNull().default(0),
  durationMs:  bigint('duration_ms', { mode: 'number' }).notNull().default(0),
  reason:      text('reason').notNull(), // cost_exceeded | duration_exceeded | retry_exceeded | manual
  stopped:     boolean('stopped').notNull().default(false),
  stoppedAt:   bigint('stopped_at', { mode: 'number' }),
  detectedAt:  bigint('detected_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rj_workspace_idx').on(t.workspaceId),
  index('rj_job_id_idx').on(t.jobId),
  index('rj_detected_idx').on(t.detectedAt),
  index('rj_stopped_idx').on(t.stopped),
])

// ─── Remote Runtime Foundation ────────────────────────────────────────────────

/** Remote worker registry — GPU / browser / CPU workers */
export const workerRegistry = pgTable('worker_registry', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  workerName:       text('worker_name').notNull(),
  workerType:       text('worker_type').notNull().default('cpu'),  // cpu|gpu|browser|hybrid
  capabilities:     text('capabilities').array().notNull().default([]),
  endpointUrl:      text('endpoint_url'),
  metadata:         jsonb('metadata').notNull().default({}),
  status:           text('status').notNull().default('idle'),  // idle|busy|offline|draining
  maxConcurrent:    integer('max_concurrent').notNull().default(1),
  activeLeases:     integer('active_leases').notNull().default(0),
  lastHeartbeatAt:  bigint('last_heartbeat_at', { mode: 'number' }),
  registeredAt:     bigint('registered_at', { mode: 'number' }).notNull(),
  staleThresholdMs: integer('stale_threshold_ms').notNull().default(60_000),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('wr_workspace_idx').on(t.workspaceId),
  index('wr_status_idx').on(t.status),
  index('wr_type_idx').on(t.workerType),
  index('wr_heartbeat_idx').on(t.lastHeartbeatAt),
])

/** Execution leases — job ownership by worker with timeout enforcement */
export const executionLeases = pgTable('execution_leases', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  workerId:    text('worker_id').notNull(),
  jobId:       text('job_id').notNull(),
  jobType:     text('job_type').notNull().default('ai'),  // ai|browser|remote|workflow
  status:      text('status').notNull().default('active'),  // active|completed|expired|reclaimed|cancelled
  startedAt:   bigint('started_at', { mode: 'number' }).notNull(),
  expiresAt:   bigint('expires_at', { mode: 'number' }).notNull(),
  renewedAt:   bigint('renewed_at', { mode: 'number' }),
  completedAt: bigint('completed_at', { mode: 'number' }),
  reclaimedAt: bigint('reclaimed_at', { mode: 'number' }),
  timeoutMs:   integer('timeout_ms').notNull().default(300_000),
  costUsd:     real('cost_usd').notNull().default(0),
  metadata:    jsonb('metadata').notNull().default({}),
  workflowRunId: text('workflow_run_id'),     // attribution (nullable)
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('el_workspace_idx').on(t.workspaceId),
  index('el_worker_idx').on(t.workerId),
  index('el_job_idx').on(t.jobId),
  index('el_status_idx').on(t.status),
  index('el_workflow_idx').on(t.workflowRunId),
  index('el_expires_idx').on(t.expiresAt),
])

/** Provider composite scores + circuit breaker state */
export const providerScores = pgTable('provider_scores', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  providerId:       text('provider_id').notNull(),
  latencyScore:     real('latency_score').notNull().default(1.0),
  successScore:     real('success_score').notNull().default(1.0),
  costScore:        real('cost_score').notNull().default(1.0),
  capabilityScore:  real('capability_score').notNull().default(1.0),
  compositeScore:   real('composite_score').notNull().default(1.0),
  sampleCount:      integer('sample_count').notNull().default(0),
  lastLatencyMs:    real('last_latency_ms'),
  lastErrorRate:    real('last_error_rate').notNull().default(0),
  circuitState:     text('circuit_state').notNull().default('closed'),  // closed|open|half_open
  circuitOpenedAt:  bigint('circuit_opened_at', { mode: 'number' }),
  circuitFailures:  integer('circuit_failures').notNull().default(0),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('ps_workspace_provider_idx').on(t.workspaceId, t.providerId),
  index('ps_workspace_idx').on(t.workspaceId),
  index('ps_composite_idx').on(t.compositeScore),
  index('ps_circuit_idx').on(t.circuitState),
])

// ─── Runtime Protection (Phase 2) ────────────────────────────────────────────

/** Fine-grained budget caps: per-user, per-project, per-provider, per-workflow */
export const budgetCaps = pgTable('budget_caps', {
  id:                   text('id').primaryKey(),
  workspaceId:          text('workspace_id').notNull(),
  scopeType:            text('scope_type').notNull(),   // workspace|user|project|provider|workflow
  scopeId:              text('scope_id').notNull(),
  maxDailyUsd:          real('max_daily_usd').notNull().default(0),
  maxMonthlyUsd:        real('max_monthly_usd').notNull().default(0),
  maxPerExecutionUsd:   real('max_per_execution_usd').notNull().default(0),
  maxWorkflowUsd:       real('max_workflow_usd').notNull().default(0),
  currentDailyUsd:      real('current_daily_usd').notNull().default(0),
  currentMonthlyUsd:    real('current_monthly_usd').notNull().default(0),
  dailyResetAt:         bigint('daily_reset_at', { mode: 'number' }).notNull(),
  monthlyResetAt:       bigint('monthly_reset_at', { mode: 'number' }).notNull(),
  enabled:              boolean('enabled').notNull().default(true),
  createdAt:            bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:            bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('bc_scope_idx').on(t.workspaceId, t.scopeType, t.scopeId),
  index('bc_workspace_idx').on(t.workspaceId),
  index('bc_scope_type_idx').on(t.scopeType),
])

/** Per-execution preflight cost estimates and hard-block decisions */
export const executionGuards = pgTable('execution_guards', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  executionId:      text('execution_id').notNull(),    // run_id or job_id
  scopeType:        text('scope_type').notNull(),
  scopeId:          text('scope_id').notNull(),
  providerId:       text('provider_id').notNull(),
  estimatedCostUsd: real('estimated_cost_usd').notNull().default(0),
  decision:         text('decision').notNull(),        // approved | blocked
  blockReason:      text('block_reason'),
  capId:            text('cap_id'),
  actualCostUsd:    real('actual_cost_usd'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('eg_workspace_idx').on(t.workspaceId),
  index('eg_execution_idx').on(t.executionId),
  index('eg_decision_idx').on(t.decision),
  index('eg_created_idx').on(t.createdAt),
])

/** Provider quarantine — beyond circuit breaker; manual or timed release */
export const providerQuarantine = pgTable('provider_quarantine', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  providerId:     text('provider_id').notNull(),
  reason:         text('reason').notNull(),
  quarantinedAt:  bigint('quarantined_at', { mode: 'number' }).notNull(),
  releaseAt:      bigint('release_at', { mode: 'number' }),       // null = manual only
  releasedAt:     bigint('released_at', { mode: 'number' }),
  autoRelease:    boolean('auto_release').notNull().default(false),
  releasedBy:     text('released_by'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('pq_workspace_provider_idx').on(t.workspaceId, t.providerId),
  index('pq_workspace_idx').on(t.workspaceId),
  index('pq_released_idx').on(t.releasedAt),
])

/** Queue pause state — per-workspace per-queue */
export const queuePauses = pgTable('queue_pauses', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  queueName:   text('queue_name').notNull(),
  paused:      boolean('paused').notNull().default(false),
  reason:      text('reason'),
  pausedBy:    text('paused_by'),
  pausedAt:    bigint('paused_at', { mode: 'number' }),
  resumedAt:   bigint('resumed_at', { mode: 'number' }),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('qp_workspace_queue_idx').on(t.workspaceId, t.queueName),
  index('qp_workspace_idx').on(t.workspaceId),
  index('qp_paused_idx').on(t.paused),
])

// ─── Replay & Recovery (Phase 3) ─────────────────────────────────────────────

/** Audit trail for workflow replay attempts */
export const replayRuns = pgTable('replay_runs', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  sourceRunId:         text('source_run_id').notNull(),
  checkpointId:        text('checkpoint_id'),
  status:              text('status').notNull().default('running'),  // running|completed|failed|diverged
  eventCount:          integer('event_count').notNull().default(0),
  replayedCount:       integer('replayed_count').notNull().default(0),
  divergedAtEventId:   text('diverged_at_event_id'),
  divergenceReason:    text('divergence_reason'),
  startedAt:           bigint('started_at', { mode: 'number' }).notNull(),
  completedAt:         bigint('completed_at', { mode: 'number' }),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rpr_workspace_idx').on(t.workspaceId),
  index('rpr_source_run_idx').on(t.sourceRunId),
  index('rpr_status_idx').on(t.status),
  index('rpr_created_idx').on(t.createdAt),
])

/** State divergences detected during replay */
export const replayDivergences = pgTable('replay_divergences', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  replayRunId:    text('replay_run_id').notNull(),
  eventId:        text('event_id').notNull(),
  eventType:      text('event_type').notNull(),
  expectedState:  jsonb('expected_state').notNull(),
  actualState:    jsonb('actual_state').notNull(),
  divergenceType: text('divergence_type').notNull(),  // state_mismatch|missing_event|extra_event|unexpected_error
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rpd_workspace_idx').on(t.workspaceId),
  index('rpd_replay_run_idx').on(t.replayRunId),
  index('rpd_created_idx').on(t.createdAt),
])

// ─── Cloud / API-Only Runtime Mode (Phase 4) ─────────────────────────────────

/** Per-workspace runtime mode configuration */
export const runtimeSettings = pgTable('runtime_settings', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  mode:               text('mode').notNull().default('local'),  // local|hybrid|cloud-api-only
  allowLocalGpu:      boolean('allow_local_gpu').notNull().default(true),
  allowLocalBrowser:  boolean('allow_local_browser').notNull().default(true),
  preferredProviders: text('preferred_providers').array().notNull().default([]),
  createdAt:          bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('rs_workspace_idx').on(t.workspaceId),
  index('rs_mode_idx').on(t.mode),
])

/** Per-user provider API credentials (scoped to user within workspace) */
export const userProviderCreds = pgTable('user_provider_creds', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  userId:           text('user_id').notNull(),
  providerId:       text('provider_id').notNull(),
  label:            text('label').notNull(),
  apiKeyEncrypted:  text('api_key_encrypted'),
  apiKeyIv:         text('api_key_iv'),
  enabled:          boolean('enabled').notNull().default(true),
  lastValidatedAt:  bigint('last_validated_at', { mode: 'number' }),
  validationStatus: text('validation_status').notNull().default('unknown'),  // unknown|valid|invalid
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('upc_user_provider_idx').on(t.workspaceId, t.userId, t.providerId),
  index('upc_workspace_idx').on(t.workspaceId),
  index('upc_user_idx').on(t.userId),
])

/** Budget alerts — fired threshold notifications */
export const budgetAlerts = pgTable('budget_alerts', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  alertType:    text('alert_type').notNull(), // daily | weekly | monthly | per_job
  thresholdPct: real('threshold_pct').notNull(),
  currentUsd:   real('current_usd').notNull(),
  limitUsd:     real('limit_usd').notNull(),
  dismissed:    boolean('dismissed').notNull().default(false),
  dismissedAt:  bigint('dismissed_at', { mode: 'number' }),
  firedAt:      bigint('fired_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ba_workspace_idx').on(t.workspaceId),
  index('ba_fired_idx').on(t.firedAt),
  index('ba_dismissed_idx').on(t.dismissed),
])

// ─── Autonomous Agent System ──────────────────────────────────────────────────

/** Top-level autonomous run — persisted state machine */
export const autonomousRuns = pgTable('autonomous_runs', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  status:              text('status').notNull().default('queued'),  // queued|running|paused|blocked|failed|complete|cancelled
  phase:               text('phase'),  // scan|audit|plan|patch|verify|done
  masterPrompt:        text('master_prompt').notNull(),
  currentAgent:        text('current_agent'),
  activeJobId:         text('active_job_id'),
  lastEvent:           text('last_event'),
  failureReason:       text('failure_reason'),
  verificationResults: jsonb('verification_results'),
  completedAt:         bigint('completed_at', { mode: 'number' }),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ar_workspace_idx').on(t.workspaceId),
  index('ar_status_idx').on(t.status),
  index('ar_created_idx').on(t.createdAt),
])

/** Individual agent job within an autonomous run */
export const autonomousJobs = pgTable('autonomous_jobs', {
  id:           text('id').primaryKey(),
  runId:        text('run_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  agentName:    text('agent_name').notNull(),  // repo-scanner|auditor|planner|patch-executor|verifier
  phase:        text('phase').notNull(),
  status:       text('status').notNull().default('queued'),  // queued|running|paused|blocked|failed|complete|unverified
  bullmqJobId:  text('bullmq_job_id'),
  input:        jsonb('input').notNull().default({}),
  output:       jsonb('output'),
  errorMessage: text('error_message'),
  attempt:      integer('attempt').notNull().default(1),
  startedAt:    bigint('started_at', { mode: 'number' }),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('aj_run_idx').on(t.runId),
  index('aj_workspace_idx').on(t.workspaceId),
  index('aj_status_idx').on(t.status),
  index('aj_phase_idx').on(t.phase),
  index('aj_created_idx').on(t.createdAt),
])

/** Verification evidence — real command output required before marking verified */
export const verificationEvidence = pgTable('verification_evidence', {
  id:           text('id').primaryKey(),
  jobId:        text('job_id').notNull(),
  runId:        text('run_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  command:      text('command').notNull(),  // e.g. "tsc --noEmit"
  args:         text('args').array().notNull().default([]),
  exitCode:     integer('exit_code').notNull(),
  stdout:       text('stdout').notNull().default(''),
  stderr:       text('stderr').notNull().default(''),
  passed:       boolean('passed').notNull(),
  durationMs:   integer('duration_ms').notNull().default(0),
  filesChanged: text('files_changed').array().notNull().default([]),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ve_job_idx').on(t.jobId),
  index('ve_run_idx').on(t.runId),
  index('ve_workspace_idx').on(t.workspaceId),
  index('ve_passed_idx').on(t.passed),
  index('ve_created_idx').on(t.createdAt),
])

/** Patch records — file changes applied by the patch executor */
export const patchRecords = pgTable('patch_records', {
  id:              text('id').primaryKey(),
  jobId:           text('job_id').notNull(),
  runId:           text('run_id').notNull(),
  workspaceId:     text('workspace_id').notNull(),
  filePath:        text('file_path').notNull(),
  originalContent: text('original_content').notNull(),  // stored for rollback
  patchedContent:  text('patched_content').notNull(),
  linesAdded:      integer('lines_added').notNull().default(0),
  linesRemoved:    integer('lines_removed').notNull().default(0),
  status:          text('status').notNull().default('applied'),  // applied|rolled_back|verified
  rolledBackAt:    bigint('rolled_back_at', { mode: 'number' }),
  rollbackReason:  text('rollback_reason'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pr_job_idx').on(t.jobId),
  index('pr_run_idx').on(t.runId),
  index('pr_workspace_idx').on(t.workspaceId),
  index('pr_status_idx').on(t.status),
  index('pr_file_idx').on(t.filePath),
])

/** Repo snapshots — lightweight file inventory before patching */
export const repoSnapshots = pgTable('repo_snapshots', {
  id:          text('id').primaryKey(),
  runId:       text('run_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  rootPath:    text('root_path').notNull(),
  fileCount:   integer('file_count').notNull().default(0),
  totalLines:  integer('total_lines').notNull().default(0),
  fileTree:    jsonb('file_tree').notNull().default([]),  // array of { path, size, lines, type }
  summary:     jsonb('summary').notNull().default({}),   // { byType, byDirectory }
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rss_run_idx').on(t.runId),
  index('rss_workspace_idx').on(t.workspaceId),
])

// ─── Audit System ─────────────────────────────────────────────────────────────

/** Top-level audit run — tracks a full-repo scan */
export const auditRuns = pgTable('audit_runs', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  status:       text('status').notNull().default('running'),  // running|complete|failed
  rootPath:     text('root_path').notNull(),
  filesScanned: integer('files_scanned').notNull().default(0),
  findingCount: integer('finding_count').notNull().default(0),
  criticalCount: integer('critical_count').notNull().default(0),
  highCount:    integer('high_count').notNull().default(0),
  taskCount:    integer('task_count').notNull().default(0),
  errorMessage: text('error_message'),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ar2_workspace_idx').on(t.workspaceId),
  index('ar2_status_idx').on(t.status),
  index('ar2_created_idx').on(t.createdAt),
])

/** Individual audit finding — references a real file and line */
export const auditFindings = pgTable('audit_findings', {
  id:          text('id').primaryKey(),
  auditRunId:  text('audit_run_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  category:    text('category').notNull(),    // critical_runtime|security|budget_cost|replay_rollback|provider_routing|ui_wiring|testing|polish
  severity:    text('severity').notNull(),    // critical|high|medium|low
  patternId:   text('pattern_id').notNull(),  // which pattern matched
  filePath:    text('file_path').notNull(),   // absolute path
  lineNumber:  integer('line_number').notNull().default(1),
  matchedText: text('matched_text').notNull(),
  description: text('description').notNull(),
  suggestion:  text('suggestion').notNull(),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('af_run_idx').on(t.auditRunId),
  index('af_workspace_idx').on(t.workspaceId),
  index('af_category_idx').on(t.category),
  index('af_severity_idx').on(t.severity),
  index('af_file_idx').on(t.filePath),
])

/** Prioritised build task generated from audit findings */
export const buildTasks = pgTable('build_tasks', {
  id:               text('id').primaryKey(),
  auditRunId:       text('audit_run_id').notNull(),
  findingId:        text('finding_id'),            // primary finding that triggered this
  workspaceId:      text('workspace_id').notNull(),
  title:            text('title').notNull(),
  description:      text('description').notNull(),
  category:         text('category').notNull(),
  severity:         text('severity').notNull(),
  priority:         integer('priority').notNull().default(50),  // lower = higher priority
  status:           text('status').notNull().default('pending'), // pending|assigned|in_progress|complete|blocked|approval_required
  requiresApproval: boolean('requires_approval').notNull().default(false),
  assignedAgent:    text('assigned_agent'),
  blastRadius:      text('blast_radius').notNull().default('low'), // low|medium|high|critical
  filePath:         text('file_path'),
  autonomousJobId:  text('autonomous_job_id'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('bt_run_idx').on(t.auditRunId),
  index('bt_workspace_idx').on(t.workspaceId),
  index('bt_status_idx').on(t.status),
  index('bt_priority_idx').on(t.priority),
  index('bt_severity_idx').on(t.severity),
  index('bt_category_idx').on(t.category),
])

// ─── Patch Approval Gates ─────────────────────────────────────────────────────

/**
 * Patch-level approval records — separate from workflow approvals.
 * Created by the risk classifier when a build task is classified as risky.
 * Agent enforcement blocks execution until status = 'approved'.
 */
export const patchApprovals = pgTable('patch_approvals', {
  id:              text('id').primaryKey(),
  taskId:          text('task_id').notNull(),          // buildTasks.id
  auditRunId:      text('audit_run_id').notNull(),
  workspaceId:     text('workspace_id').notNull(),
  // Risk classification
  riskLevel:       text('risk_level').notNull(),        // low|medium|high|critical
  riskCategories:  text('risk_categories').array().notNull().default([]),  // auth|payment|database|...
  riskReason:      text('risk_reason').notNull(),        // human-readable explanation
  // Task context
  taskTitle:       text('task_title').notNull(),
  filePath:        text('file_path'),
  affectedFiles:   text('affected_files').array().notNull().default([]),
  diffPreview:     text('diff_preview'),               // truncated diff shown to reviewer
  // Lifecycle
  status:          text('status').notNull().default('pending'), // pending|approved|rejected|changes_requested
  reviewerId:      text('reviewer_id'),
  reviewerNote:    text('reviewer_note'),
  reviewedAt:      bigint('reviewed_at', { mode: 'number' }),
  expiresAt:       bigint('expires_at', { mode: 'number' }),   // auto-expire after 7 days
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pa_task_idx').on(t.taskId),
  index('pa_run_idx').on(t.auditRunId),
  index('pa_workspace_idx').on(t.workspaceId),
  index('pa_status_idx').on(t.status),
  index('pa_risk_idx').on(t.riskLevel),
  index('pa_created_idx').on(t.createdAt),
])

// ─── Sandbox Execution System ─────────────────────────────────────────────────

/**
 * One record per sandboxed command execution.
 * Tracks lease ownership, heartbeat, timeout, and worker identity.
 */
export const sandboxSessions = pgTable('sandbox_sessions', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  jobId:          text('job_id'),           // links to autonomousJobs if from orchestrator
  runId:          text('run_id'),
  // Worker lease — one owner at a time
  leaseOwner:     text('lease_owner').notNull(),     // workerId that claimed this session
  leaseExpiresAt: bigint('lease_expires_at', { mode: 'number' }).notNull(),
  lastHeartbeat:  bigint('last_heartbeat',   { mode: 'number' }).notNull(),
  // Execution metadata
  command:        text('command').notNull(),
  args:           text('args').array().notNull().default([]),
  workingDir:     text('working_dir').notNull(),
  status:         text('status').notNull().default('running'), // running|complete|failed|timeout|cancelled|isolation_violation
  exitCode:       integer('exit_code'),
  durationMs:     integer('duration_ms'),
  timeoutMs:      integer('timeout_ms').notNull().default(120000),
  startedAt:      bigint('started_at',   { mode: 'number' }).notNull(),
  completedAt:    bigint('completed_at', { mode: 'number' }),
  // Redacted output (never raw secrets)
  stdoutRedacted: text('stdout_redacted').notNull().default(''),
  stderrRedacted: text('stderr_redacted').notNull().default(''),
  secretsRedacted: integer('secrets_redacted').notNull().default(0), // count of redacted tokens
  violationReason: text('violation_reason'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ss_workspace_idx').on(t.workspaceId),
  index('ss_job_idx').on(t.jobId),
  index('ss_status_idx').on(t.status),
  index('ss_lease_owner_idx').on(t.leaseOwner),
  index('ss_started_idx').on(t.startedAt),
])

/**
 * Structured lifecycle events per sandbox session.
 * All events contain only redacted output — no raw secrets.
 */
export const sandboxEvents = pgTable('sandbox_events', {
  id:          text('id').primaryKey(),
  sessionId:   text('session_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  eventType:   text('event_type').notNull(), // started|command_executed|heartbeat|timeout|failed|completed|secret_redacted|isolation_violation
  leaseOwner:  text('lease_owner').notNull(),
  payload:     jsonb('payload').notNull().default({}),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sev_session_idx').on(t.sessionId),
  index('sev_workspace_idx').on(t.workspaceId),
  index('sev_type_idx').on(t.eventType),
  index('sev_created_idx').on(t.createdAt),
])

// ─── Incident Response System ─────────────────────────────────────────────────

/**
 * Production incidents — each one references real runtime signals.
 * Created by the detector or manually; never fake.
 */
export const incidents = pgTable('incidents', {
  id:              text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  // Classification
  type:            text('type').notNull(),     // failed_workflow_spike|provider_outage|worker_heartbeat_failure|queue_backlog|budget_burn|replay_divergence|rollback_failure
  severity:        text('severity').notNull(), // info|warning|critical|emergency
  status:          text('status').notNull().default('open'), // open|acknowledged|mitigating|resolved|escalated
  // Title + context
  title:           text('title').notNull(),
  summary:         text('summary').notNull(),
  rootCauseHypothesis: text('root_cause_hypothesis'),
  // Affected systems (real, queried from DB)
  affectedSystems: jsonb('affected_systems').notNull().default({}), // { workflowIds, providerId, workerId, queueName, projectId }
  // Linked runtime evidence — pointers to real DB rows
  linkedEventIds:  text('linked_event_ids').array().notNull().default([]),
  signalCount:     integer('signal_count').notNull().default(0),  // how many real signals contributed
  // Triage output
  recommendedAction: text('recommended_action'),
  assignedAgent:   text('assigned_agent'),
  repairTaskId:    text('repair_task_id'),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  // Lifecycle
  acknowledgedBy:  text('acknowledged_by'),
  acknowledgedAt:  bigint('acknowledged_at', { mode: 'number' }),
  resolvedBy:      text('resolved_by'),
  resolvedAt:      bigint('resolved_at', { mode: 'number' }),
  resolutionNote:  text('resolution_note'),
  escalatedAt:     bigint('escalated_at', { mode: 'number' }),
  escalationReason: text('escalation_reason'),
  // Metadata
  detectedAt:      bigint('detected_at', { mode: 'number' }).notNull(),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('inc_workspace_idx').on(t.workspaceId),
  index('inc_status_idx').on(t.status),
  index('inc_severity_idx').on(t.severity),
  index('inc_type_idx').on(t.type),
  index('inc_detected_idx').on(t.detectedAt),
  // HOT-PATH composites
  index('inc_ws_status_idx').on(t.workspaceId, t.status),
  index('inc_ws_severity_detected_idx').on(t.workspaceId, t.severity, t.detectedAt),
])

/**
 * Issues — the unified engineering ledger.
 *
 * One row per discrete problem. Threads through the full lifecycle:
 *   symptom → diagnosis → proposed fix → patch → verification → closure
 *
 * Distinct from `incidents` (runtime alerts that may or may not require
 * code changes) and `code_proposals` (concrete code change drafts).
 * An issue can reference both: it's the unified handle for a single bug.
 *
 * Dedup strategy: see fingerprint field — services that auto-ingest from
 * signal sources (cron.error, smoke regressions, security scans) compute
 * a stable fingerprint and append evidence to an existing open issue
 * instead of creating duplicates.
 */
export const issues = pgTable('issues', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),

  // Diagnosis format (matches prompt §2)
  symptom:          text('symptom').notNull(),
  rootCause:        text('root_cause'),
  evidence:         jsonb('evidence').notNull().default([]),  // [{ type, ref, summary, at }]
  affectedSystems:  text('affected_systems').array().notNull().default([]),
  severity:         text('severity').notNull().default('warning'),  // info|warning|critical|emergency
  riskLevel:        text('risk_level'),                              // low|medium|high|critical
  proposedFix:      text('proposed_fix'),
  verificationPlan: text('verification_plan'),
  rollbackPlan:     text('rollback_plan'),

  // Lifecycle
  status:           text('status').notNull().default('open'),
  // open → triaged → diagnosed → patched → verified → closed
  // open → rejected (won't fix)
  source:           text('source').notNull(),
  // operator | cron-incident | smoke-regression | security-scan | cron-failure | autonomous-mind
  fingerprint:      text('fingerprint').notNull(),  // stable dedup key

  // Links to other records (nullable — issue can exist before they do)
  sourceIncidentId: text('source_incident_id'),
  sourceEventId:    text('source_event_id'),
  proposalId:       text('proposal_id'),
  patchId:          text('patch_id'),
  commitSha:        text('commit_sha'),

  // Audit
  createdBy:        text('created_by').notNull().default('system'),
  diagnosedBy:      text('diagnosed_by'),
  closedBy:         text('closed_by'),
  detectedAt:       bigint('detected_at',  { mode: 'number' }).notNull(),
  diagnosedAt:      bigint('diagnosed_at', { mode: 'number' }),
  closedAt:         bigint('closed_at',    { mode: 'number' }),
  createdAt:        bigint('created_at',   { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at',   { mode: 'number' }).notNull(),
}, (t) => [
  index('issue_workspace_idx').on(t.workspaceId),
  index('issue_status_idx').on(t.status),
  index('issue_severity_idx').on(t.severity),
  index('issue_source_idx').on(t.source),
  index('issue_fingerprint_idx').on(t.workspaceId, t.fingerprint),
  index('issue_detected_idx').on(t.detectedAt),
  // HOT-PATH composite: filter (workspace, status) order by detectedAt
  index('issue_ws_status_detected_idx').on(t.workspaceId, t.status, t.detectedAt),
])

/**
 * Ideas — the personal-intelligence-to-product ledger.
 *
 * Each row is one extracted (or manually entered) idea. Goes through:
 *   raw → clarified → validated → blueprinted → promoted (→ business) | archived | rejected
 *
 * Source-traced: every idea points at the chat/file/note it came from
 * via sourceType + sourceRef + sourceExcerpt. The fingerprint dedupes
 * near-duplicate ideas extracted across multiple imports.
 *
 * Promotion: when an idea is promoted, `promotedToBusinessId` is set to
 * the row created by constructBusiness(). The link is one-way: a single
 * business can come from one idea, but new ideas may emerge from a
 * running business — those get their own row.
 */
export const ideas = pgTable('ideas', {
  id:                   text('id').primaryKey(),
  workspaceId:          text('workspace_id').notNull(),

  // Identity
  title:                text('title').notNull(),
  raw:                  text('raw').notNull(),                  // original snippet that produced this idea
  fingerprint:          text('fingerprint').notNull(),          // dedup key (title+category normalized)

  // Extraction (nullable until enriched)
  category:             text('category'),                       // saas|website|tool|extension|content|commerce|service|other
  targetUser:           text('target_user'),
  painPoint:            text('pain_point'),
  solution:             text('solution'),
  features:             jsonb('features').notNull().default([]),// string[]
  monetization:         text('monetization'),
  techStack:            jsonb('tech_stack').notNull().default([]),// string[]

  // Scoring (operator-editable; 0..100 scales)
  demandScore:          integer('demand_score'),
  difficultyScore:      integer('difficulty_score'),
  buildReadiness:       integer('build_readiness'),
  upsideScore:          integer('upside_score'),
  riskScore:            integer('risk_score'),

  // Source traceability
  sourceType:           text('source_type').notNull(),          // chat|file|note|paste|manual|chat-import
  sourceRef:            text('source_ref'),                     // file id, chat id, event id, etc.
  sourceExcerpt:        text('source_excerpt'),                 // 500-char window around the extraction

  // Lifecycle
  status:               text('status').notNull().default('raw'),
  // raw | clarified | validated | blueprinted | promoted | archived | rejected
  promotedToBusinessId: text('promoted_to_business_id'),
  promotedAt:           bigint('promoted_at', { mode: 'number' }),
  archivedAt:           bigint('archived_at', { mode: 'number' }),
  rejectedReason:       text('rejected_reason'),

  // Audit
  createdBy:            text('created_by').notNull().default('system'),
  createdAt:            bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:            bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('idea_workspace_idx').on(t.workspaceId),
  index('idea_status_idx').on(t.status),
  index('idea_category_idx').on(t.category),
  index('idea_fingerprint_idx').on(t.workspaceId, t.fingerprint),
  index('idea_source_idx').on(t.sourceType, t.sourceRef),
  index('idea_created_idx').on(t.createdAt),
])

/**
 * Skill library — imported instructional knowledge (markdown). Each row
 * is one SKILL.md file from an external repo (e.g. awesome-copilot).
 *
 * Distinct from the executable `skills` table above: that one represents
 * runnable workflows; this one is reference documentation that callers
 * can inject into prompts or display to the operator.
 *
 *   - `fileHash` makes re-ingestion idempotent. Same file = same row.
 *   - `useCount` + `lastUsedAt` are bumped only when callers explicitly
 *     record usage. No silent counter inflation.
 */
export const skillLibrary = pgTable('skill_library', {
  id:           text('id').primaryKey(),          // slug (kebab-case from folder name)
  workspaceId:  text('workspace_id').notNull(),   // 'global' for the shared library
  name:         text('name').notNull(),
  description:  text('description').notNull(),
  body:         text('body').notNull(),           // full markdown content
  license:      text('license'),
  sourceRepo:   text('source_repo'),              // e.g. 'awesome-copilot'
  sourcePath:   text('source_path').notNull(),    // path within the repo
  category:     text('category'),                 // dotnet|react|sql|security|ai|...
  tags:         text('tags').array().notNull().default([]),
  fileHash:     text('file_hash').notNull(),      // sha256(body)
  useCount:     integer('use_count').notNull().default(0),
  lastUsedAt:   bigint('last_used_at',  { mode: 'number' }),
  importedAt:   bigint('imported_at',   { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at',    { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at',    { mode: 'number' }).notNull(),
}, (t) => [
  index('sklib_workspace_idx').on(t.workspaceId),
  index('sklib_category_idx').on(t.category),
  index('sklib_use_idx').on(t.useCount),
  index('sklib_hash_idx').on(t.fileHash),
])

/**
 * Entity relationships — the world graph substrate.
 *
 * One row per typed edge between two real rows in the system. Every
 * edge is BACKED by an actual FK relationship that exists in the
 * source data — we don't infer, we project.
 *
 * Source-of-truth pattern: when an `issues.proposalId` is set, the
 * populator inserts an `(issue, iss-X) → (proposal, prop-Y)` edge with
 * relationship='spawned-proposal'. The edge is derived data; if the
 * source field is cleared, the edge gets deleted on next populate.
 *
 * `evidence` carries a small JSON blob describing why the edge exists
 * (typically the FK column name + a timestamp). Operator can trust the
 * edge because the evidence row points at a real source record.
 *
 * `confidence` is 1.0 for FK-derived edges. We reserve <1.0 for future
 * inferred edges (semantic similarity, embedding distance). Today all
 * edges are 1.0 because we refuse to ship inference theater.
 */
export const entityRelationships = pgTable('entity_relationships', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  sourceKind:   text('source_kind').notNull(),    // issue|idea|proposal|patch|business|incident|action|account
  sourceId:     text('source_id').notNull(),
  targetKind:   text('target_kind').notNull(),
  targetId:     text('target_id').notNull(),
  /** Verb describing the edge (spawned-proposal, promoted-to, etc). */
  relationship: text('relationship').notNull(),
  /** Why this edge exists — typically { via: 'issues.proposalId', at: timestamp }. */
  evidence:     jsonb('evidence').notNull().default({}),
  confidence:   real('confidence').notNull().default(1),  // FK-derived = 1.0
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rel_workspace_idx').on(t.workspaceId),
  index('rel_source_idx').on(t.sourceKind, t.sourceId),
  index('rel_target_idx').on(t.targetKind, t.targetId),
  index('rel_unique_idx').on(t.workspaceId, t.sourceKind, t.sourceId, t.targetKind, t.targetId, t.relationship),
])

/**
 * Operator presence — one row per (workspace, operator) tracking when
 * the operator last actively interacted with Novan. The recap engine
 * uses `lastSeenAt` as the "since you were away" boundary.
 *
 * Why per-operator: multi-operator workspaces want each person's own
 * "while you were gone" delta. `operatorId` defaults to 'default' so
 * single-user setups don't need to wire identity.
 */
export const operatorPresence = pgTable('operator_presence', {
  workspaceId:    text('workspace_id').notNull(),
  operatorId:     text('operator_id').notNull().default('default'),
  /** Updated when operator dismisses the recap (or otherwise pings the touch endpoint). */
  lastSeenAt:     bigint('last_seen_at',  { mode: 'number' }).notNull(),
  /** Updated on every recap fetch — separate from lastSeenAt so we can
   *  show "Welcome back" without resetting the boundary until the
   *  operator acknowledges. */
  lastPolledAt:   bigint('last_polled_at', { mode: 'number' }),
  createdAt:      bigint('created_at',    { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at',    { mode: 'number' }).notNull(),
}, (t) => [
  index('op_presence_idx').on(t.workspaceId, t.operatorId),
])

/**
 * Connector kill switches — emergency stop flags, one row per workspace.
 *
 * Three orthogonal switches the action runtime checks before every
 * dispatch:
 *   - allBlocked       — global kill: no connector action runs anywhere
 *   - categoryBlocked  — array of categories paused (e.g. ['commerce','social'])
 *   - connectorBlocked — array of connector IDs paused (e.g. ['shopify'])
 *
 * Operator-set. Stored separately from accounts so flipping global stop
 * is one write, not N writes across every account row.
 */
export const connectorKillSwitches = pgTable('connector_kill_switches', {
  workspaceId:      text('workspace_id').primaryKey(),
  allBlocked:       boolean('all_blocked').notNull().default(false),
  categoryBlocked:  text('category_blocked').array().notNull().default([]),
  connectorBlocked: text('connector_blocked').array().notNull().default([]),
  reason:           text('reason'),
  setBy:            text('set_by'),
  setAt:            bigint('set_at',     { mode: 'number' }),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
})

/**
 * Connector rate limits — per-(account, action) sliding-window counter.
 * Action runtime increments on dispatch; if count exceeds threshold
 * within window, the dispatch is blocked with reason 'rate_limited'.
 *
 * Defaults (in code, not config): 60 actions per minute per (account,action).
 * Window is reset by computing count of recent connector_actions rows;
 * this table holds operator-overridable per-key overrides.
 */
export const connectorRateLimits = pgTable('connector_rate_limits', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  accountId:       text('account_id'),       // null = applies to all accounts of below action
  action:          text('action'),            // null = applies to all actions of above account
  maxPerMinute:    integer('max_per_minute').notNull().default(60),
  maxPerHour:      integer('max_per_hour').notNull().default(600),
  setBy:           text('set_by'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('conn_rl_workspace_idx').on(t.workspaceId),
  index('conn_rl_account_idx').on(t.accountId, t.action),
])

/**
 * Connector registry — one row per known connector KIND (not per
 * account). Defines what GitHub / Slack / etc. look like: auth type,
 * supported actions, blocked actions, risk level, default scopes.
 *
 * Connector instances (an actual account a workspace has linked) live
 * in `connector_accounts` below.
 */
export const connectors = pgTable('connectors', {
  id:               text('id').primaryKey(),          // slug: 'github', 'slack', 'gmail', 'gcal'
  name:             text('name').notNull(),
  category:         text('category').notNull(),       // communication|productivity|developer|...
  description:      text('description').notNull(),
  authType:         text('auth_type').notNull(),      // oauth|api_key|token|session|webhook
  defaultScopes:    text('default_scopes').array().notNull().default([]),
  optionalScopes:   text('optional_scopes').array().notNull().default([]),
  supportedActions: text('supported_actions').array().notNull().default([]),
  /** Actions PERMANENTLY blocked at the connector level regardless of
   *  operator approval — purchases, payments, account deletion, etc. */
  blockedActions:   text('blocked_actions').array().notNull().default([]),
  riskLevel:        text('risk_level').notNull().default('low'), // low|medium|high
  /** Whether a real handler is wired. Stays false until the SDK calls
   *  are implemented; routes will refuse dispatch when false. */
  implemented:      boolean('implemented').notNull().default(false),
  // ── Authorization & signup metadata (the second-prompt demand) ───
  // Null means "operator must verify before relying on this URL."
  officialWebsiteUrl:    text('official_website_url'),
  signupUrl:             text('signup_url'),
  loginUrl:              text('login_url'),
  oauthAuthorizationUrl: text('oauth_authorization_url'),
  developerAppSetupUrl:  text('developer_app_setup_url'),
  apiKeyCreationUrl:     text('api_key_creation_url'),
  docsUrl:               text('docs_url'),
  pricingUrl:            text('pricing_url'),
  statusPageUrl:         text('status_page_url'),
  permissionExplanation: text('permission_explanation'),
  accountRequired:       boolean('account_required').notNull().default(true),
  supportsOauth:         boolean('supports_oauth').notNull().default(false),
  supportsApiKey:        boolean('supports_api_key').notNull().default(false),
  supportsSessionAuth:   boolean('supports_session_auth').notNull().default(false),
  freeTierAvailable:     boolean('free_tier_available').notNull().default(false),
  /** ISO timestamp of last operator metadata verification. Null = unverified. */
  metadataVerifiedAt:    bigint('metadata_verified_at', { mode: 'number' }),
  iconKey:               text('icon_key'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('connector_category_idx').on(t.category),
  index('connector_implemented_idx').on(t.implemented),
])

/**
 * Connector accounts — a workspace's linked instance of a connector.
 * Credentials live in `secrets_vault`; this row only holds the FK to
 * that secret plus permission scopes, status, and health.
 *
 * Per-workspace per-account: a workspace can have multiple GitHub
 * accounts linked (e.g. personal + org).
 */
export const connectorAccounts = pgTable('connector_accounts', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  connectorId:      text('connector_id').notNull(),   // FK to connectors.id
  /** Human label — "github (personal)", "gcal (work)" */
  label:            text('label').notNull(),
  /** External account identifier from the provider (login, email, id). */
  externalAccount:  text('external_account'),
  /** FK to secrets_vault.id; null until OAuth/key entry completes. */
  secretRef:        text('secret_ref'),
  /** Scopes actually GRANTED (≤ connector.defaultScopes ⊆ provider grant). */
  grantedScopes:    text('granted_scopes').array().notNull().default([]),
  /** Operator-set permission tier: read|draft|publish|admin.
   *  Action runtime checks both grantedScopes AND this tier. */
  permission:       text('permission').notNull().default('read'),
  status:           text('status').notNull().default('active'),  // active|paused|revoked|expired
  health:           text('health').notNull().default('unknown'), // healthy|degraded|down|unknown
  lastActionAt:     bigint('last_action_at', { mode: 'number' }),
  lastHealthAt:     bigint('last_health_at', { mode: 'number' }),
  metadata:         jsonb('metadata').notNull().default({}),
  createdBy:        text('created_by').notNull().default('operator'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('conn_acct_workspace_idx').on(t.workspaceId),
  index('conn_acct_connector_idx').on(t.connectorId),
  index('conn_acct_status_idx').on(t.status),
])

/**
 * Connector actions — append-only audit log. Every dispatch creates one
 * row that tracks the full 7-stage pipeline: intent → permission →
 * policy → dry_run → approval → exec → outcome. Phase column tells you
 * exactly where a still-pending action is parked.
 */
export const connectorActions = pgTable('connector_actions', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  accountId:        text('account_id').notNull(),     // FK to connector_accounts.id
  connectorId:      text('connector_id').notNull(),

  // Intent
  action:           text('action').notNull(),         // e.g. 'github.create_issue'
  intent:           text('intent').notNull(),         // human description
  params:           jsonb('params').notNull().default({}),
  riskLevel:        text('risk_level').notNull().default('low'),

  // Pipeline state
  phase:            text('phase').notNull().default('queued'),
  // queued|permission_check|policy_check|dry_run|awaiting_approval|approved|executing|completed|failed|blocked|rejected
  blockedReason:    text('blocked_reason'),
  dryRunPreview:    jsonb('dry_run_preview'),         // what WOULD happen — shown to operator

  // Approval
  requiresApproval: boolean('requires_approval').notNull().default(false),
  approvedBy:       text('approved_by'),
  approvedAt:       bigint('approved_at',  { mode: 'number' }),
  rejectedBy:       text('rejected_by'),
  rejectedAt:       bigint('rejected_at',  { mode: 'number' }),
  rejectionReason:  text('rejection_reason'),

  // Execution
  startedAt:        bigint('started_at',   { mode: 'number' }),
  completedAt:      bigint('completed_at', { mode: 'number' }),
  result:           jsonb('result'),
  errorMessage:     text('error_message'),

  // Audit
  initiatedBy:      text('initiated_by').notNull(),   // 'operator' | agent id | 'cron:<task>'
  correlationId:    text('correlation_id'),           // links related actions
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('conn_act_workspace_idx').on(t.workspaceId),
  index('conn_act_account_idx').on(t.accountId),
  index('conn_act_phase_idx').on(t.phase),
  index('conn_act_approval_idx').on(t.requiresApproval, t.phase),
  index('conn_act_created_idx').on(t.createdAt),
])

/** Append-only timeline of actions on an incident */
export const incidentTimeline = pgTable('incident_timeline', {
  id:          text('id').primaryKey(),
  incidentId:  text('incident_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  actionType:  text('action_type').notNull(), // opened|updated|acknowledged|escalated|resolved|triage_completed|repair_task_created|mitigation_started
  actor:       text('actor').notNull().default('system'),
  note:        text('note'),
  payload:     jsonb('payload').notNull().default({}),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('inct_incident_idx').on(t.incidentId),
  index('inct_workspace_idx').on(t.workspaceId),
  index('inct_created_idx').on(t.createdAt),
])

// ─── Learning Runtime: Failure Memory ─────────────────────────────────────────

/**
 * Failure memory — every failed patch/command/provider call/worker run.
 * Backed by real evidence IDs. Used to block repeat-failure attempts.
 */
export const failureMemory = pgTable('failure_memory', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  // Classification
  failureType:       text('failure_type').notNull(),    // patch|command|provider_call|worker_exec|recovery
  rootCauseClass:    text('root_cause_class').notNull(),// syntax|build|runtime|data|ui|performance|security|infra|unknown
  // Target (what failed)
  targetRef:         text('target_ref').notNull(),     // file path | command | providerId | workerId
  targetKind:        text('target_kind').notNull(),    // file|command|provider|worker|job
  // Signature for dedup/grouping
  signature:         text('signature').notNull(),       // hash of failureType + targetRef + rootCauseClass + errorPattern
  errorPattern:      text('error_pattern').notNull(),   // truncated error message pattern
  // Context
  agentId:           text('agent_id'),                  // which agent caused/handled this
  // Evidence pointers — real row IDs only
  evidenceIds:       text('evidence_ids').array().notNull().default([]),
  // Fix attempt tracking
  attemptedFixIds:   text('attempted_fix_ids').array().notNull().default([]),
  occurrenceCount:   integer('occurrence_count').notNull().default(1),
  blocked:           boolean('blocked').notNull().default(false), // true once we refuse further retries
  firstSeenAt:       bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:        bigint('last_seen_at',  { mode: 'number' }).notNull(),
  createdAt:         bigint('created_at',    { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at',    { mode: 'number' }).notNull(),
}, (t) => [
  index('fm_workspace_idx').on(t.workspaceId),
  index('fm_signature_idx').on(t.signature),
  index('fm_target_idx').on(t.targetRef),
  index('fm_type_idx').on(t.failureType),
  index('fm_agent_idx').on(t.agentId),
  index('fm_count_idx').on(t.occurrenceCount),
])

/**
 * Successful fixes — verified patches/commands that resolved a failure.
 * Linked to verification evidence with passed=true.
 */
export const successfulFixes = pgTable('successful_fixes', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  failureSignature:  text('failure_signature').notNull(), // matches failureMemory.signature
  fixDescription:    text('fix_description').notNull(),
  targetRef:         text('target_ref').notNull(),
  agentId:           text('agent_id'),
  // Real evidence — verificationEvidence row IDs where passed=true
  verificationEvidenceIds: text('verification_evidence_ids').array().notNull().default([]),
  patchRecordIds:    text('patch_record_ids').array().notNull().default([]),
  successCount:      integer('success_count').notNull().default(1),
  firstAppliedAt:    bigint('first_applied_at', { mode: 'number' }).notNull(),
  lastAppliedAt:     bigint('last_applied_at',  { mode: 'number' }).notNull(),
  createdAt:         bigint('created_at',       { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at',       { mode: 'number' }).notNull(),
}, (t) => [
  index('sf_workspace_idx').on(t.workspaceId),
  index('sf_signature_idx').on(t.failureSignature),
  index('sf_target_idx').on(t.targetRef),
  index('sf_agent_idx').on(t.agentId),
])

// ─── Multi-Agent Orchestrator ─────────────────────────────────────────────────

/** Registered agent workers — capabilities, heartbeat, metrics */
export const agentRegistrations = pgTable('agent_registrations', {
  id:               text('id').primaryKey(),       // agentId
  workspaceId:      text('workspace_id').notNull(),
  agentName:        text('agent_name').notNull(),
  capabilities:     text('capabilities').array().notNull().default([]),
  status:           text('status').notNull().default('idle'), // idle|busy|down|disabled|restarting
  lastHeartbeat:    bigint('last_heartbeat', { mode: 'number' }).notNull(),
  // Health metrics
  activeAssignments: integer('active_assignments').notNull().default(0),
  successCount:     integer('success_count').notNull().default(0),
  failureCount:     integer('failure_count').notNull().default(0),
  rollbackCount:    integer('rollback_count').notNull().default(0),
  registeredAt:     bigint('registered_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at',    { mode: 'number' }).notNull(),
}, (t) => [
  index('areg_workspace_idx').on(t.workspaceId),
  index('areg_status_idx').on(t.status),
  index('areg_heartbeat_idx').on(t.lastHeartbeat),
])

/** Assignment of a task to an agent (1:1 ownership) */
export const agentAssignments = pgTable('agent_assignments', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  agentId:      text('agent_id').notNull(),
  taskKind:     text('task_kind').notNull(),   // build_task|incident_repair|workflow|audit_task
  taskRef:      text('task_ref').notNull(),    // ID into the target table
  status:       text('status').notNull().default('assigned'), // assigned|running|complete|failed|cancelled|blocked
  // Dependency tracking
  dependsOn:    text('depends_on').array().notNull().default([]),  // other assignment IDs
  priority:     integer('priority').notNull().default(50),
  assignedAt:   bigint('assigned_at',  { mode: 'number' }).notNull(),
  startedAt:    bigint('started_at',   { mode: 'number' }),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  errorMessage: text('error_message'),
  updatedAt:    bigint('updated_at',   { mode: 'number' }).notNull(),
}, (t) => [
  index('aa_workspace_idx').on(t.workspaceId),
  index('aa_agent_idx').on(t.agentId),
  index('aa_task_idx').on(t.taskRef),
  index('aa_status_idx').on(t.status),
  index('aa_priority_idx').on(t.priority),
])

/** Execution locks — file / workflow / queue level */
export const executionLocks = pgTable('execution_locks', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  lockKind:     text('lock_kind').notNull(),    // file|workflow|queue|task
  resourceKey:  text('resource_key').notNull(), // canonical path or ID
  holderId:     text('holder_id').notNull(),    // agentId or assignmentId
  holderKind:   text('holder_kind').notNull().default('agent'), // agent|assignment|worker
  acquiredAt:   bigint('acquired_at', { mode: 'number' }).notNull(),
  expiresAt:    bigint('expires_at',  { mode: 'number' }).notNull(),
  releasedAt:   bigint('released_at', { mode: 'number' }),
  recoveredAt:  bigint('recovered_at', { mode: 'number' }), // if stale-recovered
}, (t) => [
  // Unique active lock per (kind, key) when not released — enforced in service layer
  index('exlock_workspace_idx').on(t.workspaceId),
  index('exlock_resource_idx').on(t.lockKind, t.resourceKey),
  index('exlock_holder_idx').on(t.holderId),
  index('exlock_expires_idx').on(t.expiresAt),
])

// ─── Production Readiness Audits + Launch Lock ────────────────────────────────

/**
 * Persisted production readiness audit report.
 * Each row = one full audit run with per-check results.
 */
export const launchAudits = pgTable('launch_audits', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  // Overall result
  readinessScore:    integer('readiness_score').notNull().default(0),  // 0-100
  passedCount:       integer('passed_count').notNull().default(0),
  failedCount:       integer('failed_count').notNull().default(0),
  skippedCount:      integer('skipped_count').notNull().default(0),
  unverifiedCount:   integer('unverified_count').notNull().default(0),
  criticalBlockers:  integer('critical_blockers').notNull().default(0),
  // Per-check results (jsonb array)
  checkResults:      jsonb('check_results').notNull().default([]),  // [{ name, status, severity, evidence, reason }]
  recommendedFixes:  jsonb('recommended_fixes').notNull().default([]),
  // Triggered-by metadata
  triggeredBy:       text('triggered_by').notNull().default('system'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('la_workspace_idx').on(t.workspaceId),
  index('la_score_idx').on(t.readinessScore),
  index('la_created_idx').on(t.createdAt),
])

/**
 * Launch lock — single row per workspace.
 * Blocks production launch until critical checks pass.
 */
export const launchLocks = pgTable('launch_locks', {
  id:                text('id').primaryKey(),     // = workspaceId
  workspaceId:       text('workspace_id').notNull(),
  locked:            boolean('locked').notNull().default(true),
  blockingReasons:   text('blocking_reasons').array().notNull().default([]),
  lastAuditId:       text('last_audit_id'),
  lastAuditScore:    integer('last_audit_score'),
  // Override
  overrideActive:    boolean('override_active').notNull().default(false),
  overrideBy:        text('override_by'),
  overrideReason:    text('override_reason'),
  overrideAt:        bigint('override_at', { mode: 'number' }),
  overrideExpiresAt: bigint('override_expires_at', { mode: 'number' }),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ll_workspace_idx').on(t.workspaceId),
  index('ll_locked_idx').on(t.locked),
])

// ─── Self-Improvement Runtime ─────────────────────────────────────────────────

/** Evidence-backed improvement recommendations */
export const optimizationRecommendations = pgTable('optimization_recommendations', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  // Classification
  category:        text('category').notNull(),   // reliability|performance|cost|ux|tests|observability|infra
  subject:         text('subject').notNull(),    // free-form target (file, provider, agent, workflow id)
  title:           text('title').notNull(),
  description:     text('description').notNull(),
  // Ranking
  impact:          integer('impact').notNull().default(50),  // 0-100
  risk:            integer('risk').notNull().default(50),    // 0-100
  priorityScore:   integer('priority_score').notNull().default(0),  // computed
  // Evidence — real row IDs only
  evidenceRefs:    jsonb('evidence_refs').notNull().default([]),  // [{ table, id }]
  // Lifecycle
  status:          text('status').notNull().default('open'),  // open|in_roadmap|applied|blocked|dismissed
  requiresApproval: boolean('requires_approval').notNull().default(false),
  recommendedAgent: text('recommended_agent'),
  dismissedReason: text('dismissed_reason'),
  detectedAt:      bigint('detected_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at',  { mode: 'number' }).notNull(),
}, (t) => [
  index('opt_workspace_idx').on(t.workspaceId),
  index('opt_category_idx').on(t.category),
  index('opt_status_idx').on(t.status),
  index('opt_priority_idx').on(t.priorityScore),
])

/** Roadmap tasks generated from recommendations */
export const roadmapTasks = pgTable('roadmap_tasks', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  recommendationId: text('recommendation_id'),       // source recommendation
  phase:           text('phase').notNull(),          // immediate|near_term|backlog
  title:           text('title').notNull(),
  description:     text('description').notNull(),
  category:        text('category').notNull(),
  impact:          integer('impact').notNull(),
  risk:            integer('risk').notNull(),
  priorityScore:   integer('priority_score').notNull(),
  assignedAgent:   text('assigned_agent'),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  status:          text('status').notNull().default('pending'), // pending|approved|in_progress|complete|blocked|skipped
  predecessors:    text('predecessors').array().notNull().default([]),  // recommendationIds that must complete first
  missionAlignment: text('mission_alignment').array().notNull().default([]),  // mission tags this task aligns to
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rt_workspace_idx').on(t.workspaceId),
  index('rt_phase_idx').on(t.phase),
  index('rt_status_idx').on(t.status),
  index('rt_priority_idx').on(t.priorityScore),
])

// ─── External Knowledge — internet learning ──────────────────────────────────

/**
 * Every URL Novan fetches from the public internet lands here.
 * Content is redacted (no leaked secrets), size-capped (~200kb), and
 * timestamped. The improvement-engine + ai-router can reference these rows
 * to ground future decisions in real external context.
 */
export const externalKnowledge = pgTable('external_knowledge', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  url:               text('url').notNull(),
  source:            text('source').notNull().default('manual'),  // manual|cron-rss|llm-research
  fetchedAt:         bigint('fetched_at', { mode: 'number' }).notNull(),
  status:            integer('status').notNull(),       // HTTP status
  contentType:       text('content_type'),
  contentRedacted:   text('content_redacted').notNull(),// post-redaction body
  contentBytes:      integer('content_bytes').notNull().default(0),
  secretsRedacted:   integer('secrets_redacted').notNull().default(0),
  title:             text('title'),
  tags:              text('tags').array().notNull().default([]),
  expiresAt:         bigint('expires_at', { mode: 'number' }),   // TTL — re-fetch after
  fetchedBy:         text('fetched_by'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ek_workspace_idx').on(t.workspaceId),
  index('ek_url_idx').on(t.url),
  index('ek_source_idx').on(t.source),
  index('ek_fetched_idx').on(t.fetchedAt),
  index('ek_expires_idx').on(t.expiresAt),
])

/**
 * External feeds Novan subscribes to (RSS/Atom).
 * Cron periodically polls each enabled feed, fetches new items, lands content
 * in external_knowledge for the brain to reference.
 */
export const externalFeeds = pgTable('external_feeds', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  feedUrl:           text('feed_url').notNull(),
  name:              text('name').notNull(),
  tags:              text('tags').array().notNull().default([]),
  intervalSeconds:   integer('interval_seconds').notNull().default(3600),
  enabled:           boolean('enabled').notNull().default(true),
  lastPolledAt:      bigint('last_polled_at', { mode: 'number' }),
  lastSuccessAt:     bigint('last_success_at', { mode: 'number' }),
  lastError:         text('last_error'),
  itemsIngested:     integer('items_ingested').notNull().default(0),
  pollCount:         integer('poll_count').notNull().default(0),
  errorCount:        integer('error_count').notNull().default(0),
  maxItemsPerPoll:   integer('max_items_per_poll').notNull().default(5),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ef_workspace_idx').on(t.workspaceId),
  index('ef_enabled_idx').on(t.enabled),
  index('ef_polled_idx').on(t.lastPolledAt),
])

// ─── AI Response Cache + Token Stretching Metrics ─────────────────────────────

/**
 * Cache for AI responses keyed by (model, messages, task_type) hash.
 * Token-stretcher checks this before hitting any provider.
 */
export const aiResponseCache = pgTable('ai_response_cache', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  cacheKey:          text('cache_key').notNull(),
  model:             text('model').notNull(),
  taskType:          text('task_type'),
  promptTokens:      integer('prompt_tokens').notNull().default(0),
  responseTokens:    integer('response_tokens').notNull().default(0),
  response:          text('response').notNull(),
  hitCount:          integer('hit_count').notNull().default(0),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  lastHitAt:         bigint('last_hit_at', { mode: 'number' }),
  expiresAt:         bigint('expires_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('arc_key_idx').on(t.workspaceId, t.cacheKey),
  index('arc_expires_idx').on(t.expiresAt),
])

// ─── Research Learning Engine ─────────────────────────────────────────────────

/**
 * User-approved research topics. The research engine polls active topics
 * on a schedule and persists findings to research_findings.
 */
export const researchTopics = pgTable('research_topics', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  topic:             text('topic').notNull(),
  description:       text('description'),
  approvedSources:   text('approved_sources').array().notNull().default([]),
  approvedAgents:    text('approved_agents').array().notNull().default([]),
  status:            text('status').notNull().default('active'),   // active | paused | killed
  pollIntervalSec:   integer('poll_interval_sec').notNull().default(21600),  // 6h default
  maxFindingsPerRun: integer('max_findings_per_run').notNull().default(10),
  lastRunAt:         bigint('last_run_at', { mode: 'number' }),
  lastSuccessAt:     bigint('last_success_at', { mode: 'number' }),
  lastError:         text('last_error'),
  runCount:          integer('run_count').notNull().default(0),
  findingsCount:     integer('findings_count').notNull().default(0),
  createdBy:         text('created_by'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rtopic_workspace_idx').on(t.workspaceId),
  index('rtopic_status_idx').on(t.status),
  index('rtopic_last_run_idx').on(t.lastRunAt),
])

/**
 * Persisted research findings — every fact, summary, and citation lands here.
 * factType: 'fact' | 'opinion' | 'guess' (per safety spec).
 */
export const researchFindings = pgTable('research_findings', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  topicId:           text('topic_id'),
  agentId:           text('agent_id'),                    // which research agent produced this
  sourceUrl:         text('source_url').notNull(),
  sourceTitle:       text('source_title'),
  factType:          text('fact_type').notNull().default('fact'),  // fact | opinion | guess
  summary:           text('summary').notNull(),
  extractedFacts:    jsonb('extracted_facts').notNull().default([]),  // array of {text, kind}
  citations:         jsonb('citations').notNull().default([]),        // [{url, title, anchor}]
  confidence:        real('confidence').notNull().default(0.5),
  contentHash:       text('content_hash').notNull(),                  // sha256 for dedup
  fetchedAt:         bigint('fetched_at', { mode: 'number' }).notNull(),
  freshAt:           bigint('fresh_at', { mode: 'number' }).notNull(),
  embedding:         vector('embedding', { dimensions: 768 }),        // optional; filled when embeddings enabled
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rf_workspace_idx').on(t.workspaceId),
  index('rf_topic_idx').on(t.topicId),
  index('rf_agent_idx').on(t.agentId),
  uniqueIndex('rf_hash_idx').on(t.workspaceId, t.contentHash),
  index('rf_fresh_idx').on(t.freshAt),
])

// ─── AI Image Generation ──────────────────────────────────────────────────────

/** Audit + history of every image generation call. */
export const imageGenerations = pgTable('image_generations', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  prompt:            text('prompt').notNull(),
  enhancedPrompt:    text('enhanced_prompt'),                       // from prompt-rewriter
  negativePrompt:    text('negative_prompt'),
  provider:          text('provider').notNull(),     // openai | stability | replicate | fal
  model:             text('model'),
  stylePreset:       text('style_preset'),
  aspectRatio:       text('aspect_ratio'),
  width:             integer('width'),
  height:            integer('height'),
  seed:              integer('seed'),                               // reproducibility
  batchId:           text('batch_id'),                              // groups multi-image generations
  sourceImageRef:    text('source_image_ref'),                      // image-to-image input
  brandCategory:     text('brand_category'),                        // icon|logo|hero|mockup|ad|social|thumbnail|ui_concept|landing|other
  costEstimateUsd:   real('cost_estimate_usd').notNull().default(0),
  actualCostUsd:     real('actual_cost_usd'),
  status:            text('status').notNull().default('pending'),  // pending | succeeded | failed | blocked
  blockedReason:     text('blocked_reason'),
  imageUrl:          text('image_url'),
  imagePath:         text('image_path'),
  providerResponse:  jsonb('provider_response'),
  errorMessage:      text('error_message'),
  // Quality + favorites
  userRating:        integer('user_rating'),                        // 1..5 stars (operator-set)
  isFavorite:        boolean('is_favorite').notNull().default(false),
  qualityScore:      real('quality_score'),                         // computed from rating + provider perf
  slopRiskScore:     real('slop_risk_score'),                       // 0..1, anti-slop engine
  originalityScore:  real('originality_score'),                     // 0..1, IP / originality
  compositionScore:  real('composition_score'),                     // 0..1
  brandFitScore:     real('brand_fit_score'),                       // 0..1
  creativeFlags:     jsonb('creative_flags'),                       // string[] from scorePrompt()
  // Provenance
  routerProvenance:  text('router_provenance'),                     // 'auto' | 'user_pinned'
  latencyMs:         integer('latency_ms'),
  createdBy:         text('created_by'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  completedAt:       bigint('completed_at', { mode: 'number' }),
  // Attribution (nullable; callers populate for per-workflow/per-trace cost rollups)
  traceId:           text('trace_id'),
  workflowRunId:     text('workflow_run_id'),
}, (t) => [
  index('ig_workspace_idx').on(t.workspaceId),
  index('ig_status_idx').on(t.status),
  index('ig_provider_idx').on(t.provider),
  index('ig_created_idx').on(t.createdAt),
  index('ig_favorite_idx').on(t.isFavorite),
  index('ig_batch_idx').on(t.batchId),
  index('ig_trace_idx').on(t.traceId),
  index('ig_workflow_idx').on(t.workflowRunId),
])

/** Migration 0033 — image quality reviews. */
export const imageQualityReviews = pgTable('image_quality_reviews', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  generationId: text('generation_id').notNull(),
  kind:         text('kind').notNull(),
  verdict:      text('verdict').notNull(),
  composite:    real('composite').notNull(),
  qualityScore: real('quality_score').notNull(),
  slopRisk:     real('slop_risk').notNull(),
  originality:  real('originality').notNull(),
  composition:  real('composition').notNull(),
  brandFit:     real('brand_fit').notNull(),
  reasons:      jsonb('reasons').notNull().default([]),
  reviewer:     text('reviewer'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('iqr_workspace_idx').on(t.workspaceId),
  index('iqr_generation_idx').on(t.generationId),
  index('iqr_verdict_idx').on(t.verdict),
  index('iqr_created_idx').on(t.createdAt),
])

/** Reusable prompt templates. */
export const promptTemplates = pgTable('prompt_templates', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  name:              text('name').notNull(),
  category:          text('category').notNull().default('image'),  // image|research|general
  brandCategory:     text('brand_category'),                        // for image templates
  prompt:            text('prompt').notNull(),
  negativePrompt:    text('negative_prompt'),
  defaultProvider:   text('default_provider'),
  defaultModel:      text('default_model'),
  defaultAspectRatio: text('default_aspect_ratio'),
  tags:              text('tags').array().notNull().default([]),
  useCount:          integer('use_count').notNull().default(0),
  createdBy:         text('created_by'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('promptt_workspace_idx').on(t.workspaceId),
  index('promptt_category_idx').on(t.category),
])

// ─── Reality Anchoring + Ground Truth ───────────────────────────────────────

/**
 * Assumptions tracker — every load-bearing belief the platform holds.
 * Tracked through a verification lifecycle.
 *
 * Status:
 *   unverified  — recorded, no evidence yet
 *   verifying   — re-check in progress
 *   verified    — at least one piece of supporting evidence
 *   invalidated — direct contradicting evidence found
 *   stale       — verified once but not re-checked in >7 days
 */
export const assumptions = pgTable('assumptions', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  category:          text('category').notNull(),         // runtime|provider|operator|telemetry|test|recommendation|forecast|strategic
  statement:         text('statement').notNull(),
  evidenceRefs:      jsonb('evidence_refs').notNull().default([]),  // [{table, id, extract}]
  confidence:        real('confidence').notNull().default(0.5),
  confidenceProvenance: text('confidence_provenance').notNull().default('heuristic'),
  status:            text('status').notNull().default('unverified'),
  source:            text('source').notNull(),           // service or operator name
  lastVerifiedAt:    bigint('last_verified_at', { mode: 'number' }),
  lastInvalidatedAt: bigint('last_invalidated_at', { mode: 'number' }),
  verificationCount: integer('verification_count').notNull().default(0),
  invalidationCount: integer('invalidation_count').notNull().default(0),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('asm_workspace_idx').on(t.workspaceId),
  index('asm_status_idx').on(t.status),
  index('asm_category_idx').on(t.category),
  index('asm_last_verified_idx').on(t.lastVerifiedAt),
])

/**
 * Drift warnings — automated flags when reality contradicts platform belief.
 */
export const driftWarnings = pgTable('drift_warnings', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  kind:              text('kind').notNull(),             // repeated_wrong_prediction|stale_belief|failed_recommendations|low_confidence_loop|unsupported_conclusion
  subjectId:         text('subject_id'),                 // chain id, assumption id, etc.
  severity:          text('severity').notNull(),         // low|medium|high|critical
  evidence:          jsonb('evidence').notNull().default([]),
  recommendedAction: text('recommended_action').notNull(),
  appliedAction:     text('applied_action'),             // 'confidence_reduced' | 'revalidation_required' | etc.
  status:            text('status').notNull().default('open'),  // open | acknowledged | resolved
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  resolvedAt:        bigint('resolved_at', { mode: 'number' }),
}, (t) => [
  index('drift_workspace_idx').on(t.workspaceId),
  index('drift_status_idx').on(t.status),
  index('drift_kind_idx').on(t.kind),
])

// ─── Knowledge Compression + Pattern Extraction ─────────────────────────────

/**
 * Compressed lessons — operator-readable summaries derived from real
 * source rows. sourceRefs MUST point back to real records; never
 * fabricated.
 */
export const compressedLessons = pgTable('compressed_lessons', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  kind:              text('kind').notNull(),               // failure_cluster | fix_pattern | research_synthesis | incident_pattern | operator_friction
  title:             text('title').notNull(),
  summary:           text('summary').notNull(),
  abstractedLesson:  text('abstracted_lesson'),
  sourceTable:       text('source_table').notNull(),       // failure_memory | successful_fixes | etc.
  sourceRefs:        text('source_refs').array().notNull().default([]),  // row IDs in source table
  sourceCount:       integer('source_count').notNull(),
  confidence:        real('confidence').notNull().default(0.5),
  confidenceProvenance: text('confidence_provenance').notNull().default('heuristic'),
  embedding:         vector('embedding', { dimensions: 768 }),
  archivedAt:        bigint('archived_at', { mode: 'number' }),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('cl_workspace_idx').on(t.workspaceId),
  index('cl_kind_idx').on(t.kind),
  index('cl_archived_idx').on(t.archivedAt),
])

/**
 * Duplicate merge log — every dedup decision is auditable.
 */
export const duplicateMergeLog = pgTable('duplicate_merge_log', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  entityType:        text('entity_type').notNull(),   // incident | recommendation | research_finding | mission | skill
  primaryId:         text('primary_id').notNull(),
  duplicateId:       text('duplicate_id').notNull(),
  similarity:        real('similarity').notNull(),
  reason:            text('reason').notNull(),
  status:            text('status').notNull().default('suggested'),  // suggested | merged | dismissed
  decidedBy:         text('decided_by'),
  decidedAt:         bigint('decided_at', { mode: 'number' }),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('dml_workspace_idx').on(t.workspaceId),
  index('dml_status_idx').on(t.status),
  index('dml_entity_idx').on(t.entityType),
])

// ─── Cognitive Architecture ───────────────────────────────────────────────────

/**
 * Persistent reasoning chains — every recommendation, forecast, or
 * decision that the platform wants to be able to replay/audit later.
 * Outcomes are linked back when known.
 */
export const reasoningChains = pgTable('reasoning_chains', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  kind:              text('kind').notNull(),            // recommendation | forecast | tradeoff | decision
  subjectId:         text('subject_id'),                // e.g. recommendation.id, forecast.type
  decision:          text('decision').notNull(),        // human-readable summary of what was decided
  evidence:          jsonb('evidence').notNull().default([]),     // [{type,id,extract}]
  tradeoffs:         jsonb('tradeoffs').notNull().default([]),
  confidence:        real('confidence'),                // 0..1
  prediction:        jsonb('prediction'),               // structured forecast
  // Outcome linkage (filled in when window passes)
  outcomeKnown:      boolean('outcome_known').notNull().default(false),
  outcomeMatched:    boolean('outcome_matched'),        // true = prediction confirmed
  outcomeEvidence:   jsonb('outcome_evidence'),
  outcomeAt:         bigint('outcome_at', { mode: 'number' }),
  source:            text('source').notNull(),          // 'recommendation-engine' | 'forecasting' | etc
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rc_workspace_idx').on(t.workspaceId),
  index('rc_kind_idx').on(t.kind),
  index('rc_subject_idx').on(t.subjectId),
  index('rc_outcome_idx').on(t.outcomeKnown),
  // HOT-PATH composite: outcome reconciliation queries filter
  // (workspace, outcome_known=false, kind) — 29 queries previously
  // bitmap-ANDed three single-col indexes.
  index('rc_ws_outcome_kind_idx').on(t.workspaceId, t.outcomeKnown, t.kind),
])

/**
 * Persistent executive state — single row per workspace, updated each
 * executive review cycle. JSON blob; structure managed by service.
 */
export const executiveState = pgTable('executive_state', {
  workspaceId:       text('workspace_id').primaryKey(),
  topPriorities:     jsonb('top_priorities').notNull().default([]),
  activeRisks:       jsonb('active_risks').notNull().default([]),
  strategicObjectives: jsonb('strategic_objectives').notNull().default([]),
  blockedInitiatives: jsonb('blocked_initiatives').notNull().default([]),
  costPosture:       jsonb('cost_posture'),
  reliabilityPosture: jsonb('reliability_posture'),
  securityPosture:   jsonb('security_posture'),
  focusAreas:        text('focus_areas').array().notNull().default([]),
  lastReviewAt:      bigint('last_review_at', { mode: 'number' }),
  reviewCount:       integer('review_count').notNull().default(0),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
})

/**
 * Executive review log — audit trail of every review cycle.
 */
export const executiveReviewLog = pgTable('executive_review_log', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  cycle:             text('cycle').notNull(),           // hourly | six_hourly | daily | weekly
  triggeredBy:       text('triggered_by').notNull(),    // 'cron' | 'manual'
  signalsAnalyzed:   jsonb('signals_analyzed').notNull().default({}),
  prioritiesBefore:  jsonb('priorities_before').notNull().default([]),
  prioritiesAfter:   jsonb('priorities_after').notNull().default([]),
  actionsRecommended: jsonb('actions_recommended').notNull().default([]),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('erl_workspace_idx').on(t.workspaceId),
  index('erl_cycle_idx').on(t.cycle),
  index('erl_created_idx').on(t.createdAt),
])

/**
 * Skill registry — reusable, versioned, verified workflow definitions.
 * Skills are operator-facing executable units that wrap existing services.
 */
export const skills = pgTable('skills', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  name:              text('name').notNull(),
  slug:              text('slug').notNull(),            // url-safe
  purpose:           text('purpose').notNull(),
  category:          text('category').notNull(),        // research | image | deployment | security | patch | debug | report | analysis | ui | incident
  version:           integer('version').notNull().default(1),
  ownerAgentType:    text('owner_agent_type'),
  riskLevel:         text('risk_level').notNull().default('low'),  // low | medium | high
  requiresApproval:  boolean('requires_approval').notNull().default(false),
  // Definition (operator-readable)
  inputs:            jsonb('inputs').notNull().default([]),     // [{name,type,required}]
  outputs:           jsonb('outputs').notNull().default([]),
  steps:             jsonb('steps').notNull().default([]),      // ordered [{action, params}]
  safetyRules:       text('safety_rules').array().notNull().default([]),
  rollbackBehavior:  text('rollback_behavior'),
  verificationRequirements: jsonb('verification_requirements').notNull().default([]),
  // Performance
  successCount:      integer('success_count').notNull().default(0),
  failureCount:      integer('failure_count').notNull().default(0),
  lastUsedAt:        bigint('last_used_at', { mode: 'number' }),
  avgDurationMs:     integer('avg_duration_ms'),
  // Lifecycle
  status:            text('status').notNull().default('draft'),  // draft | verified | production | deprecated
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('skill_workspace_idx').on(t.workspaceId),
  index('skill_status_idx').on(t.status),
  index('skill_category_idx').on(t.category),
  uniqueIndex('skill_slug_idx').on(t.workspaceId, t.slug),
])

// ─── Persistent Stability Streak (governance auto-disengage) ────────────────

/** One row per workspace — survives container restart for accurate streak tracking. */
export const stabilityStreaks = pgTable('stability_streaks', {
  workspaceId:        text('workspace_id').primaryKey(),
  consecutiveStable:  integer('consecutive_stable').notNull().default(0),
  lastUpdatedAt:      bigint('last_updated_at', { mode: 'number' }).notNull(),
})

// ─── Operator Preferences (per-workspace settings) ───────────────────────────

/**
 * Per-workspace operator preferences. Single row per workspace.
 * Supersedes env-var-only governor limits, theme, default views, etc.
 */
export const operatorPreferences = pgTable('operator_preferences', {
  workspaceId:           text('workspace_id').primaryKey(),
  // Theme + UI
  theme:                 text('theme').notNull().default('dark'),    // dark | light
  defaultPage:           text('default_page'),                        // e.g. '/strategic-home'
  // Governor overrides (null = use env default)
  maxConcurrentAgents:    integer('max_concurrent_agents'),
  maxResearchPerHour:     integer('max_research_per_hour'),
  maxImagesPerHour:       integer('max_images_per_hour'),
  maxAutonomousPatchesPerDay: integer('max_autonomous_patches_per_day'),
  maxDeploymentsPerDay:    integer('max_deployments_per_day'),
  // Risk + approval bias
  approvalAutoApplyMinConfidence: real('approval_auto_apply_min_confidence').notNull().default(0.8),
  riskTolerance:          text('risk_tolerance').notNull().default('balanced'),  // conservative | balanced | aggressive
  driftCorrectionPolicy:  text('drift_correction_policy').notNull().default('balanced'),  // aggressive | balanced | notify_only
  // Misc
  metadata:              jsonb('metadata').notNull().default({}),
  createdAt:             bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:             bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── Operator Feedback + Telemetry ────────────────────────────────────────────

/**
 * Operator-reported feedback. Anything the user explicitly files goes here.
 * Kind:   issue | confusion | request | praise | abandoned
 * Status: open | acknowledged | resolved | dismissed
 */
export const feedbackReports = pgTable('feedback_reports', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  surface:      text('surface'),               // route or UI screen
  severity:     text('severity').notNull().default('normal'),
  title:        text('title').notNull(),
  body:         text('body'),
  context:      jsonb('context').notNull().default({}),  // {url, user_agent, last_actions, ...}
  status:       text('status').notNull().default('open'),
  reportedBy:   text('reported_by'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('fb_workspace_idx').on(t.workspaceId),
  index('fb_status_idx').on(t.status),
  index('fb_created_idx').on(t.createdAt),
])

/**
 * Product telemetry — feature usage, friction signals, drop-offs.
 * Lightweight numeric/categorical events; richer audit goes through `events`.
 * Workspace-scoped only — no cross-tenant aggregation.
 */
export const telemetryEvents = pgTable('telemetry_events', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  category:     text('category').notNull(),  // feature_use|friction|completion|abandonment|approval
  name:         text('name').notNull(),       // e.g. 'research.topic.created'
  surface:      text('surface'),
  outcome:      text('outcome'),               // success|failure|cancelled|blocked
  durationMs:   integer('duration_ms'),
  attributes:   jsonb('attributes').notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('tel_workspace_idx').on(t.workspaceId),
  index('tel_category_idx').on(t.category),
  index('tel_name_idx').on(t.name),
  index('tel_created_idx').on(t.createdAt),
])

/** Aggregated stretching metrics — one row per workspace. */
export const tokenStretchMetrics = pgTable('token_stretch_metrics', {
  workspaceId:           text('workspace_id').primaryKey(),
  totalCalls:            bigint('total_calls', { mode: 'number' }).notNull().default(0),
  cacheHits:             bigint('cache_hits', { mode: 'number' }).notNull().default(0),
  baselineTokensTotal:   bigint('baseline_tokens_total', { mode: 'number' }).notNull().default(0),
  stretchedTokensTotal:  bigint('stretched_tokens_total', { mode: 'number' }).notNull().default(0),
  savedTokensTotal:      bigint('saved_tokens_total', { mode: 'number' }).notNull().default(0),
  lastCallAt:            bigint('last_call_at', { mode: 'number' }),
})

// ─── Multi-Tenant Billing + Subscriptions ─────────────────────────────────────

/** Plan definitions — feature gates + numeric limits */
export const plans = pgTable('plans', {
  id:                text('id').primaryKey(),       // free|starter|pro|enterprise
  name:              text('name').notNull(),
  monthlyPriceUsd:   integer('monthly_price_usd').notNull().default(0),
  seatLimit:         integer('seat_limit').notNull().default(1),
  workflowLimit:     integer('workflow_limit').notNull().default(5),
  workspaceLimit:    integer('workspace_limit').notNull().default(1),
  monthlyTokenLimit: integer('monthly_token_limit').notNull().default(100000),
  monthlySpendLimitUsd: integer('monthly_spend_limit_usd').notNull().default(10),
  featureFlags:      jsonb('feature_flags').notNull().default({}),
  isActive:          boolean('is_active').notNull().default(true),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
})

/** Per-workspace subscription */
export const subscriptions = pgTable('subscriptions', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  planId:              text('plan_id').notNull(),
  status:              text('status').notNull().default('trialing'),
  // trialing|active|past_due|canceled|paused|expired
  stripeCustomerId:    text('stripe_customer_id'),        // never the secret key
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodStart:  bigint('current_period_start', { mode: 'number' }),
  currentPeriodEnd:    bigint('current_period_end',   { mode: 'number' }),
  trialEndsAt:         bigint('trial_ends_at',        { mode: 'number' }),
  canceledAt:          bigint('canceled_at',          { mode: 'number' }),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sub_workspace_idx').on(t.workspaceId),
  index('sub_status_idx').on(t.status),
])

/** Usage meters — counters per workspace per period */
export const usageMeters = pgTable('usage_meters', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  meterKey:     text('meter_key').notNull(),  // provider_spend_usd|tokens|workflow_runs|remote_worker_min|storage_mb|replay_count|autonomous_runs
  periodStart:  bigint('period_start', { mode: 'number' }).notNull(),
  periodEnd:    bigint('period_end',   { mode: 'number' }).notNull(),
  amount:       integer('amount').notNull().default(0),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('um_workspace_period_idx').on(t.workspaceId, t.periodStart),
  index('um_key_idx').on(t.meterKey),
])

// ─── Enterprise Security: RBAC + Secrets + Audit ──────────────────────────────

/** Granular permission grants — per (userId, workspaceId, permission) */
export const permissions = pgTable('permissions', {
  id:           text('id').primaryKey(),
  userId:       text('user_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  role:         text('role').notNull(),     // owner|admin|member|viewer
  grants:       text('grants').array().notNull().default([]),  // specific permission strings
  grantedBy:    text('granted_by'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('perm_user_workspace_idx').on(t.userId, t.workspaceId),
  index('perm_role_idx').on(t.role),
])

/**
 * Encrypted secrets vault — AES-GCM ciphertext, never raw.
 * `valueCiphertext` is base64(nonce||tag||ciphertext).
 * `valueRedacted` is a UI-safe redacted form (e.g. "sk-***********abcd").
 */
export const secretsVault = pgTable('secrets_vault', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  name:              text('name').notNull(),       // e.g. "openai_api_key"
  provider:          text('provider'),             // openai|anthropic|stripe|... or null
  valueCiphertext:   text('value_ciphertext').notNull(),
  valueRedacted:     text('value_redacted').notNull(),
  keyVersion:        integer('key_version').notNull().default(1),
  rotatedAt:         bigint('rotated_at', { mode: 'number' }),
  lastAccessedAt:    bigint('last_accessed_at', { mode: 'number' }),
  accessCount:       integer('access_count').notNull().default(0),
  createdBy:         text('created_by'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sv_workspace_idx').on(t.workspaceId),
  index('sv_name_idx').on(t.name),
  index('sv_provider_idx').on(t.provider),
])

/**
 * Security audit log — IMMUTABLE: no UPDATE/DELETE in service layer.
 * Tracks every auth attempt, permission check, secret access, suspicious event.
 */
export const securityAudits = pgTable('security_audits', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id'),  // nullable for global events (failed login w/o workspace)
  userId:       text('user_id'),
  eventType:    text('event_type').notNull(),
  // auth_failure|permission_denied|secret_accessed|secret_rotated|provider_abuse|
  // suspicious_activity|unsafe_patch_blocked|audit_exported|compliance_action
  severity:     text('severity').notNull().default('info'), // info|warning|critical
  resource:     text('resource'),       // affected resource ID
  action:       text('action'),         // attempted action
  outcome:      text('outcome').notNull(), // allowed|denied|recorded
  context:      jsonb('context').notNull().default({}),
  ipAddress:    text('ip_address'),
  userAgent:    text('user_agent'),
  immutable:    boolean('immutable').notNull().default(true),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sa_workspace_idx').on(t.workspaceId),
  index('sa_user_idx').on(t.userId),
  index('sa_event_idx').on(t.eventType),
  index('sa_severity_idx').on(t.severity),
  index('sa_created_idx').on(t.createdAt),
])

/** Audit log exports — for compliance / GDPR / SOC */
export const auditExports = pgTable('audit_exports', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  requestedBy:     text('requested_by').notNull(),
  format:          text('format').notNull().default('json'), // json|csv
  fromTs:          bigint('from_ts', { mode: 'number' }).notNull(),
  toTs:            bigint('to_ts',   { mode: 'number' }).notNull(),
  recordCount:     integer('record_count').notNull().default(0),
  status:          text('status').notNull().default('pending'), // pending|complete|failed
  downloadRef:     text('download_ref'),  // opaque ID; never a raw URL
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  completedAt:     bigint('completed_at', { mode: 'number' }),
}, (t) => [
  index('ae_workspace_idx').on(t.workspaceId),
  index('ae_status_idx').on(t.status),
])

// ─── Cyber Security Force Team ────────────────────────────────────────────────

/** Registered security agents — distinct from general agentRegistrations. */
export const securityAgents = pgTable('security_agents', {
  id:                text('id').primaryKey(),       // e.g. cso|appsec|cloud|secrets|...
  name:              text('name').notNull(),
  role:              text('role').notNull(),        // cso|appsec|cloud|secrets|runtime|tenant|patch|red|blue|compliance
  description:       text('description').notNull(),
  capabilities:      text('capabilities').array().notNull().default([]),
  isActive:          boolean('is_active').notNull().default(true),
  lastRunAt:         bigint('last_run_at', { mode: 'number' }),
  findingsProduced:  integer('findings_produced').notNull().default(0),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('seca_role_idx').on(t.role),
  index('seca_active_idx').on(t.isActive),
])

/** Security findings produced by the security team. */
export const securityFindings = pgTable('security_findings', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id'),         // nullable for global findings
  agentId:           text('agent_id').notNull(),
  agentRole:         text('agent_role').notNull(),
  severity:          text('severity').notNull(),   // info|low|medium|high|critical
  category:          text('category').notNull(),   // appsec|cloud|secrets|runtime|tenant|patch|red_team|compliance
  title:             text('title').notNull(),
  description:       text('description').notNull(),
  // Real evidence pointers
  evidenceRefs:      jsonb('evidence_refs').notNull().default([]),  // [{ table, id }]
  affectedResource:  text('affected_resource'),    // file/endpoint/agent/provider
  recommendedAction: text('recommended_action').notNull(),
  // Lifecycle
  status:            text('status').notNull().default('open'), // open|acknowledged|mitigating|resolved|false_positive
  requiresApproval:  boolean('requires_approval').notNull().default(false),
  blocksLaunch:      boolean('blocks_launch').notNull().default(false),
  mitigationTaskId:  text('mitigation_task_id'),
  reviewedBy:        text('reviewed_by'),
  reviewedAt:        bigint('reviewed_at', { mode: 'number' }),
  resolutionNote:    text('resolution_note'),
  detectedAt:        bigint('detected_at', { mode: 'number' }).notNull(),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('secf_workspace_idx').on(t.workspaceId),
  index('secf_agent_idx').on(t.agentId),
  index('secf_severity_idx').on(t.severity),
  index('secf_status_idx').on(t.status),
  index('secf_blocks_idx').on(t.blocksLaunch),
  index('secf_detected_idx').on(t.detectedAt),
])

// ─── Launch Tonight Mode: Runtime Safety Flags ────────────────────────────────

/**
 * Per-workspace safety flags. Tonight Mode sets the dangerous flags to false
 * and the safe flags to true. Every gate point in the codebase consults these.
 */
export const runtimeSafetyFlags = pgTable('runtime_safety_flags', {
  id:                              text('id').primaryKey(),  // = workspaceId
  workspaceId:                     text('workspace_id').notNull(),
  // DISABLED in tonight mode (false = blocked, true = permitted)
  autonomousDeployAllowed:         boolean('autonomous_deploy_allowed').notNull().default(false),
  selfEditLoopsAllowed:            boolean('self_edit_loops_allowed').notNull().default(false),
  autonomousDepsUpgradesAllowed:   boolean('autonomous_deps_upgrades_allowed').notNull().default(false),
  destructiveMigrationsAllowed:    boolean('destructive_migrations_allowed').notNull().default(false),
  internetLearningSwarmAllowed:    boolean('internet_learning_swarm_allowed').notNull().default(false),
  // ENABLED in tonight mode (true = on, false = off)
  approvalGatedPatchesEnabled:     boolean('approval_gated_patches_enabled').notNull().default(true),
  failureLearningEnabled:          boolean('failure_learning_enabled').notNull().default(true),
  observabilityEnabled:            boolean('observability_enabled').notNull().default(true),
  warRoomEnabled:                  boolean('war_room_enabled').notNull().default(true),
  cronScansEnabled:                boolean('cron_scans_enabled').notNull().default(true),
  incidentAlertsEnabled:           boolean('incident_alerts_enabled').notNull().default(true),
  // Metadata
  tonightModeActive:               boolean('tonight_mode_active').notNull().default(true),
  setBy:                           text('set_by'),
  notes:                           text('notes'),
  updatedAt:                       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rsf_workspace_idx').on(t.workspaceId),
  index('rsf_tonight_idx').on(t.tonightModeActive),
])

// ─── Migration 0016 — Autonomy completion ────────────────────────────────

export const actions = pgTable('actions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  type:         text('type').notNull(),
  subjectId:    text('subject_id'),
  payload:      jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status:       text('status').notNull().default('pending'),
  riskLevel:    text('risk_level').notNull().default('low'),
  requestedBy:  text('requested_by').notNull(),
  approvalId:   text('approval_id'),
  result:       jsonb('result').$type<Record<string, unknown>>(),
  error:        text('error'),
  createdAt:    bigint('created_at',   { mode: 'number' }).notNull(),
  startedAt:    bigint('started_at',   { mode: 'number' }),
  completedAt:  bigint('completed_at', { mode: 'number' }),
}, (t) => [
  index('actions_workspace_idx').on(t.workspaceId),
  index('actions_status_idx').on(t.status),
  index('actions_type_idx').on(t.type),
  index('actions_created_idx').on(t.createdAt),
])

export const revenueEvents = pgTable('revenue_events', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  source:         text('source').notNull(),
  amountUsd:      real('amount_usd').notNull(),
  currency:       text('currency').notNull().default('USD'),
  customerRef:    text('customer_ref'),
  workflowRunId:  text('workflow_run_id'),
  occurredAt:     bigint('occurred_at', { mode: 'number' }).notNull(),
  metadata:       jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:      bigint('created_at',  { mode: 'number' }).notNull(),
}, (t) => [
  index('rev_workspace_idx').on(t.workspaceId),
  index('rev_occurred_idx').on(t.occurredAt),
  index('rev_workflow_idx').on(t.workflowRunId),
])

export const recommendationFeedback = pgTable('recommendation_feedback', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  chainId:      text('chain_id').notNull(),
  action:       text('action').notNull(),
  reason:       text('reason'),
  operatorId:   text('operator_id'),
  weightDelta:  real('weight_delta').notNull().default(0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('recfeed_workspace_idx').on(t.workspaceId),
  index('recfeed_chain_idx').on(t.chainId),
  index('recfeed_action_idx').on(t.action),
])

export const inboundMessages = pgTable('inbound_messages', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  channel:      text('channel').notNull(),
  externalId:   text('external_id'),
  fromAddr:     text('from_addr'),
  subject:      text('subject'),
  body:         text('body').notNull(),
  receivedAt:   bigint('received_at',  { mode: 'number' }).notNull(),
  processedAt:  bigint('processed_at', { mode: 'number' }),
  intent:       text('intent'),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [
  index('ib_workspace_idx').on(t.workspaceId),
  index('ib_channel_idx').on(t.channel),
  index('ib_received_idx').on(t.receivedAt),
])

export const strategicHorizons = pgTable('strategic_horizons', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  horizon:      text('horizon').notNull(),
  title:        text('title').notNull(),
  objectives:   jsonb('objectives').$type<Array<Record<string, unknown>>>().notNull().default([]),
  constraints:  jsonb('constraints').$type<Array<Record<string, unknown>>>().notNull().default([]),
  reviewAt:     bigint('review_at', { mode: 'number' }).notNull(),
  status:       text('status').notNull().default('active'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sh_workspace_idx').on(t.workspaceId),
  index('sh_horizon_idx').on(t.horizon),
  index('sh_status_idx').on(t.status),
])

// ─── Migration 0017 — Self-aware platform ───────────────────────────────

export const codeProposals = pgTable('code_proposals', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  buildPlanId:   text('build_plan_id'),
  capabilityId:  text('capability_id'),
  title:         text('title').notNull(),
  summary:       text('summary').notNull(),
  filesToCreate: jsonb('files_to_create').$type<Array<{ path: string; purpose: string; estLoc: number }>>().notNull().default([]),
  filesToModify: jsonb('files_to_modify').$type<Array<{ path: string; purpose: string; estLoc: number }>>().notNull().default([]),
  testsRequired: jsonb('tests_required').$type<Array<{ description: string; covers: string }>>().notNull().default([]),
  riskLevel:     text('risk_level').notNull().default('medium'),
  estimatedLoc:  integer('estimated_loc').notNull().default(0),
  status:        text('status').notNull().default('proposed'),
  reasoning:     jsonb('reasoning').$type<string[]>().notNull().default([]),
  approvalId:    text('approval_id'),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
  shippedAt:        bigint('shipped_at', { mode: 'number' }),
  shippedCommitSha: text('shipped_commit_sha'),
  shippedBy:        text('shipped_by'),
}, (t) => [
  index('cp_workspace_idx').on(t.workspaceId),
  index('cp_status_idx').on(t.status),
  index('cp_capability_idx').on(t.capabilityId),
  index('cp_shipped_idx').on(t.shippedAt),
  // HOT-PATH composite: filter (workspace, status), shipped-at order
  index('cp_ws_status_idx').on(t.workspaceId, t.status),
])

export const workerConcurrency = pgTable('worker_concurrency', {
  workspaceId: text('workspace_id').notNull(),
  queueName:   text('queue_name').notNull(),
  factor:      real('factor').notNull().default(1.0),
  setBy:       text('set_by').notNull(),
  reason:      text('reason'),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.queueName] }),
])

export const providerPreferences = pgTable('provider_preferences', {
  workspaceId:        text('workspace_id').notNull(),
  taskType:           text('task_type').notNull(),
  preferredProvider:  text('preferred_provider').notNull(),
  setBy:              text('set_by').notNull(),
  status:             text('status').notNull().default('pending'),
  reason:             text('reason'),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.taskType] }),
])

export const codeStateSnapshots = pgTable('code_state_snapshots', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  gitSha:         text('git_sha').notNull(),
  branch:         text('branch'),
  commitMessage:  text('commit_message'),
  filesChanged:   integer('files_changed').notNull().default(0),
  committedAt:    bigint('committed_at', { mode: 'number' }).notNull(),
  capturedAt:     bigint('captured_at',  { mode: 'number' }).notNull(),
}, (t) => [
  index('cs_committed_idx').on(t.committedAt),
])

export const chainEmbeddings = pgTable('chain_embeddings', {
  chainId:     text('chain_id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  vector:      text('vector').notNull(),
  dim:         integer('dim').notNull(),
  sourceKind:  text('source_kind'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ce_workspace_idx').on(t.workspaceId),
])

// ─── Migration 0019 — Code agent ─────────────────────────────────────────

export const codePatches = pgTable('code_patches', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  proposalId:   text('proposal_id').notNull(),
  status:       text('status').notNull().default('pending'),
  agent:        text('agent').notNull().default('template'),
  files:        jsonb('files').$type<Array<{ path: string; contents: string; op: 'create' | 'modify' }>>().notNull().default([]),
  safetyReport: jsonb('safety_report').$type<Record<string, unknown>>().notNull().default({}),
  sandboxReport: jsonb('sandbox_report').$type<Record<string, unknown>>().notNull().default({}),
  blockReason:  text('block_reason'),
  tokensUsed:   integer('tokens_used').notNull().default(0),
  costUsdUsed:  real('cost_usd_used').notNull().default(0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
  completedAt:  bigint('completed_at', { mode: 'number' }),
}, (t) => [
  index('patches_workspace_idx').on(t.workspaceId),
  index('patches_proposal_idx').on(t.proposalId),
  index('patches_status_idx').on(t.status),
])

export const commitOutcomes = pgTable('commit_outcomes', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  gitSha:             text('git_sha').notNull(),
  evaluatedAt:        bigint('evaluated_at', { mode: 'number' }).notNull(),
  horizonDays:        integer('horizon_days').notNull().default(7),
  incidentsAfter:     integer('incidents_after').notNull().default(0),
  driftWarningsAfter: integer('drift_warnings_after').notNull().default(0),
  matchRateDelta:     real('match_rate_delta'),
  verdict:            text('verdict').notNull(),
  notes:              jsonb('notes').$type<string[]>().notNull().default([]),
}, (t) => [
  index('co_verdict_idx').on(t.verdict),
])

export const discoveredCapabilities = pgTable('discovered_capabilities', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  serviceFile:   text('service_file').notNull(),
  exportsCount:  integer('exports_count').notNull().default(0),
  firstSeenAt:   bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:    bigint('last_seen_at',  { mode: 'number' }).notNull(),
  maturity:      text('maturity').notNull().default('basic'),
})

// ─── Migration 0020 — Commerce, creative, trust, governance ─────────────

export const commerceSessions = pgTable('commerce_sessions', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  platform:         text('platform').notNull(),
  accountRef:       text('account_ref').notNull(),
  status:           text('status').notNull().default('pending'),
  scopes:           jsonb('scopes').$type<string[]>().notNull().default([]),
  approvalId:       text('approval_id'),
  eventsCount:      integer('events_count').notNull().default(0),
  screenshotsTaken: integer('screenshots_taken').notNull().default(0),
  startedAt:        bigint('started_at', { mode: 'number' }),
  endedAt:          bigint('ended_at', { mode: 'number' }),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('csess_workspace_idx').on(t.workspaceId),
  index('csess_status_idx').on(t.status),
])

export const commerceEvents = pgTable('commerce_events', {
  id:              text('id').primaryKey(),
  sessionId:       text('session_id').notNull(),
  workspaceId:     text('workspace_id').notNull(),
  eventType:       text('event_type').notNull(),
  url:             text('url'),
  actionText:      text('action_text'),
  screenshotPath:  text('screenshot_path'),
  requiresConfirm: boolean('requires_confirm').notNull().default(false),
  confirmed:       boolean('confirmed').notNull().default(false),
  blockedReason:   text('blocked_reason'),
  occurredAt:      bigint('occurred_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('cev_session_idx').on(t.sessionId),
  index('cev_workspace_idx').on(t.workspaceId),
  index('cev_occurred_idx').on(t.occurredAt),
])

export const accountCredentials = pgTable('account_credentials', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  platform:       text('platform').notNull(),
  accountRef:     text('account_ref').notNull(),
  vaultSecretId:  text('vault_secret_id'),
  grantedScopes:  jsonb('granted_scopes').$type<string[]>().notNull().default([]),
  paused:         boolean('paused').notNull().default(false),
  lastUsedAt:     bigint('last_used_at', { mode: 'number' }),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('ac_unique').on(t.workspaceId, t.platform, t.accountRef),
  index('ac_workspace_idx').on(t.workspaceId),
  index('ac_platform_idx').on(t.platform),
])

export const designConcepts = pgTable('design_concepts', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  brief:             text('brief').notNull(),
  prompt:            text('prompt').notNull(),
  assetImageRef:     text('asset_image_ref'),
  originalityScore:  real('originality_score'),
  ipRiskScore:       real('ip_risk_score'),
  slopScore:         real('slop_score'),
  qualityScore:      real('quality_score'),
  trendRefs:         jsonb('trend_refs').$type<string[]>().notNull().default([]),
  status:            text('status').notNull().default('draft'),
  blockReasons:      jsonb('block_reasons').$type<string[]>().notNull().default([]),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('dc_workspace_idx').on(t.workspaceId),
  index('dc_status_idx').on(t.status),
])

export const podListings = pgTable('pod_listings', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  platform:     text('platform').notNull(),
  conceptId:    text('concept_id'),
  title:        text('title').notNull(),
  description:  text('description').notNull(),
  tags:         jsonb('tags').$type<string[]>().notNull().default([]),
  assetRefs:    jsonb('asset_refs').$type<string[]>().notNull().default([]),
  externalId:   text('external_id'),
  status:       text('status').notNull().default('draft'),
  qualityScore: real('quality_score'),
  performance:  jsonb('performance').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pl_workspace_idx').on(t.workspaceId),
  index('pl_platform_idx').on(t.platform),
  index('pl_status_idx').on(t.status),
])

export const socialPosts = pgTable('social_posts', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  platform:     text('platform').notNull(),
  accountRef:   text('account_ref').notNull(),
  body:         text('body').notNull(),
  assetRefs:    jsonb('asset_refs').$type<string[]>().notNull().default([]),
  scheduledAt:  bigint('scheduled_at', { mode: 'number' }),
  postedAt:     bigint('posted_at', { mode: 'number' }),
  externalId:   text('external_id'),
  status:       text('status').notNull().default('draft'),
  approvalId:   text('approval_id'),
  engagement:   jsonb('engagement').$type<Record<string, unknown>>().notNull().default({}),
  spamScore:    real('spam_score'),
  blockReasons: jsonb('block_reasons').$type<string[]>().notNull().default([]),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sp_workspace_idx').on(t.workspaceId),
  index('sp_status_idx').on(t.status),
  index('sp_platform_idx').on(t.platform),
])

export const trendFindings = pgTable('trend_findings', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  source:       text('source').notNull(),
  niche:        text('niche').notNull(),
  signal:       text('signal').notNull(),
  score:        real('score').notNull().default(0),
  confidence:   real('confidence').notNull().default(0),
  citations:    jsonb('citations').$type<Array<{ url: string; title: string; capturedAt: number }>>().notNull().default([]),
  capturedAt:   bigint('captured_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('tf_workspace_idx').on(t.workspaceId),
  index('tf_niche_idx').on(t.niche),
  index('tf_captured_idx').on(t.capturedAt),
])

export const trustScores = pgTable('trust_scores', {
  subjectType:  text('subject_type').notNull(),
  subjectId:    text('subject_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  score:        real('score').notNull().default(0.8),
  signals:      jsonb('signals').$type<Array<{ at: number; reason: string; delta: number }>>().notNull().default([]),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.subjectType, t.subjectId] }),
  index('ts_workspace_idx').on(t.workspaceId),
])

export const postingGovernor = pgTable('posting_governor', {
  workspaceId: text('workspace_id').notNull(),
  platform:    text('platform').notNull(),
  accountRef:  text('account_ref').notNull(),
  postsToday:  integer('posts_today').notNull().default(0),
  maxPerDay:   integer('max_per_day').notNull().default(5),
  cooldownMin: integer('cooldown_min').notNull().default(45),
  lastPostAt:  bigint('last_post_at', { mode: 'number' }),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.platform, t.accountRef] }),
])

export const agentPauseState = pgTable('agent_pause_state', {
  workspaceId: text('workspace_id').notNull(),
  agentName:   text('agent_name').notNull(),
  paused:      boolean('paused').notNull().default(false),
  pausedBy:    text('paused_by'),
  pausedAt:    bigint('paused_at', { mode: 'number' }),
  reason:      text('reason'),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.agentName] }),
])

export const overrideLog = pgTable('override_log', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  actionType:     text('action_type').notNull(),
  subjectId:      text('subject_id'),
  originalStatus: text('original_status').notNull(),
  overrideStatus: text('override_status').notNull(),
  operatorId:     text('operator_id'),
  reason:         text('reason'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ol_workspace_idx').on(t.workspaceId),
  index('ol_action_idx').on(t.actionType),
  index('ol_created_idx').on(t.createdAt),
])

export const ethicalBlocks = pgTable('ethical_blocks', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  intent:      text('intent').notNull(),
  source:      text('source').notNull(),
  category:    text('category').notNull(),
  reason:      text('reason').notNull(),
  blockedAt:   bigint('blocked_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('eb_workspace_idx').on(t.workspaceId),
  index('eb_category_idx').on(t.category),
  index('eb_blocked_idx').on(t.blockedAt),
])

// ─── Migration 0021 — Fabric, identity, simulation ──────────────────────

export const runtimeNodes = pgTable('runtime_nodes', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  region:           text('region').notNull(),
  role:             text('role').notNull(),
  status:           text('status').notNull().default('healthy'),
  capacity:         integer('capacity').notNull().default(1),
  activeLoad:       integer('active_load').notNull().default(0),
  queueDepth:       integer('queue_depth').notNull().default(0),
  endpoint:         text('endpoint'),
  metadata:         jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  lastHeartbeatAt:  bigint('last_heartbeat_at', { mode: 'number' }).notNull(),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rn_workspace_idx').on(t.workspaceId),
  index('rn_status_idx').on(t.status),
  index('rn_region_idx').on(t.region),
])

export const scalingEvents = pgTable('scaling_events', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  kind:        text('kind').notNull(),
  target:      text('target').notNull(),
  before:      integer('before'),
  after:       integer('after'),
  reason:      text('reason').notNull(),
  approvedBy:  text('approved_by'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('se_workspace_idx').on(t.workspaceId),
  index('se_kind_idx').on(t.kind),
  index('se_created_idx').on(t.createdAt),
])

export const identityProfile = pgTable('identity_profile', {
  workspaceId:  text('workspace_id').primaryKey(),
  traits:       jsonb('traits').$type<Record<string, number>>().notNull().default({}),
  toneSettings: jsonb('tone_settings').$type<Record<string, unknown>>().notNull().default({}),
  version:      integer('version').notNull().default(1),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
})

export const communicationAudit = pgTable('communication_audit', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  source:              text('source').notNull(),
  outputType:          text('output_type').notNull(),
  text:                text('text').notNull(),
  hypeScore:           real('hype_score').notNull().default(0),
  uncertaintyHandling: text('uncertainty_handling').notNull(),
  factEstimateOk:      boolean('fact_estimate_ok').notNull().default(true),
  violations:          jsonb('violations').$type<Array<{ kind: string; detail: string }>>().notNull().default([]),
  passed:              boolean('passed').notNull().default(true),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ca_workspace_idx').on(t.workspaceId),
  index('ca_source_idx').on(t.source),
  index('ca_created_idx').on(t.createdAt),
])

export const scenarios = pgTable('scenarios', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  name:         text('name').notNull(),
  inputs:       jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
  bestCase:     jsonb('best_case').$type<Record<string, unknown>>().notNull().default({}),
  likelyCase:   jsonb('likely_case').$type<Record<string, unknown>>().notNull().default({}),
  worstCase:    jsonb('worst_case').$type<Record<string, unknown>>().notNull().default({}),
  confidence:   real('confidence').notNull().default(0),
  mitigation:   jsonb('mitigation').$type<string[]>().notNull().default([]),
  evidenceRefs: jsonb('evidence_refs').$type<Array<{ type: string; id: string; extract: string }>>().notNull().default([]),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sc_workspace_idx').on(t.workspaceId),
  index('sc_kind_idx').on(t.kind),
  index('sc_created_idx').on(t.createdAt),
])

export const scenarioOutcomes = pgTable('scenario_outcomes', {
  id:           text('id').primaryKey(),
  scenarioId:   text('scenario_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  observed:     jsonb('observed').$type<Record<string, unknown>>().notNull().default({}),
  matchedCase:  text('matched_case'),
  delta:        jsonb('delta').$type<Record<string, unknown>>().notNull().default({}),
  observedAt:   bigint('observed_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('so_scenario_idx').on(t.scenarioId),
  index('so_workspace_idx').on(t.workspaceId),
])

// ─── Migration 0022 — Novan chat ─────────────────────────────────────────

export const conversations = pgTable('conversations', {
  id:                       text('id').primaryKey(),
  workspaceId:              text('workspace_id').notNull(),
  title:                    text('title').notNull(),
  messageCount:             integer('message_count').notNull().default(0),
  totalTokens:              integer('total_tokens').notNull().default(0),
  totalCostUsd:             real('total_cost_usd').notNull().default(0),
  archived:                 boolean('archived').notNull().default(false),
  forkedFromConversationId: text('forked_from_conversation_id'),
  forkedFromMessageId:      text('forked_from_message_id'),
  branchRootId:             text('branch_root_id'),
  createdAt:                bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:                bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('conv_workspace_idx').on(t.workspaceId),
  index('conv_updated_idx').on(t.updatedAt),
  index('conv_branch_root_idx').on(t.branchRootId),
  index('conv_forked_from_idx').on(t.forkedFromConversationId),
])

// ─── Migration 0040 — Platform smoke self-check ────────────────────────

export const platformSmokeRuns = pgTable('platform_smoke_runs', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  ranAt:        bigint('ran_at', { mode: 'number' }).notNull(),
  durationMs:   integer('duration_ms').notNull(),
  okCount:      integer('ok_count').notNull().default(0),
  failCount:    integer('fail_count').notNull().default(0),
  slowCount:    integer('slow_count').notNull().default(0),
  probes:       jsonb('probes').$type<Array<{ path: string; status: number; ms: number; bodyExcerpt: string }>>().notNull().default([]),
  regressions:  jsonb('regressions').$type<Array<{ path: string; prevStatus: number; nowStatus: number }>>().notNull().default([]),
  source:       text('source').notNull().default('cron'),
}, (t) => [
  index('smoke_ws_idx').on(t.workspaceId),
  index('smoke_ran_idx').on(t.ranAt),
])

// ─── Migration 0039 — Agency agents catalog + CEO delegations ──────────

export const agentDefinitions = pgTable('agent_definitions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  slug:         text('slug').notNull(),
  department:   text('department').notNull(),
  name:         text('name').notNull(),
  description:  text('description'),
  color:        text('color'),
  emoji:        text('emoji'),
  vibe:         text('vibe'),
  systemPrompt: text('system_prompt').notNull(),
  sourcePath:   text('source_path'),
  checksum:     text('checksum').notNull(),
  tags:         text('tags').array().notNull().default([]),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('agentdef_ws_slug_uniq').on(t.workspaceId, t.slug),
  index('agentdef_department_idx').on(t.workspaceId, t.department),
])

export const agentDelegations = pgTable('agent_delegations', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  definitionId:     text('definition_id').notNull(),
  department:       text('department').notNull(),
  task:             text('task').notNull(),
  context:          jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
  result:           text('result'),
  tokens:           integer('tokens').notNull().default(0),
  costUsd:          real('cost_usd').notNull().default(0),
  provider:         text('provider'),
  model:            text('model'),
  status:           text('status').notNull().default('pending'),
  requestedBy:      text('requested_by').notNull().default('ceo'),
  reasoningChainId: text('reasoning_chain_id'),
  startedAt:        bigint('started_at',   { mode: 'number' }),
  completedAt:      bigint('completed_at', { mode: 'number' }),
  error:            text('error'),
  createdAt:        bigint('created_at',   { mode: 'number' }).notNull(),
}, (t) => [
  index('delegation_ws_idx').on(t.workspaceId),
  index('delegation_def_idx').on(t.definitionId),
  index('delegation_created_idx').on(t.createdAt),
  index('delegation_status_idx').on(t.status),
])

// ─── Migration 0038 — Voice cloning profiles (Coqui XTTS-v2 sidecar) ────

export const voiceProfiles = pgTable('voice_profiles', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  name:            text('name').notNull(),
  refAudioPath:    text('ref_audio_path').notNull(),
  language:        text('language').notNull().default('en'),
  consentAttested: boolean('consent_attested').notNull().default(false),
  isActive:        boolean('is_active').notNull().default(false),
  durationSeconds: real('duration_seconds'),
  sampleRate:      integer('sample_rate'),
  notes:           text('notes'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vp_workspace_idx').on(t.workspaceId),
  index('vp_active_idx').on(t.workspaceId, t.isActive),
])

export const messages = pgTable('messages', {
  id:              text('id').primaryKey(),
  conversationId:  text('conversation_id').notNull(),
  workspaceId:     text('workspace_id').notNull(),
  role:            text('role').notNull(),
  content:         text('content').notNull(),
  citations:       jsonb('citations').$type<Array<{ kind: string; id: string; extract: string }>>().notNull().default([]),
  audit:           jsonb('audit').$type<Record<string, unknown> | null>(),
  tokens:          integer('tokens').notNull().default(0),
  costUsd:         real('cost_usd').notNull().default(0),
  provider:        text('provider'),
  model:           text('model'),
  streamComplete:  boolean('stream_complete').notNull().default(true),
  error:           text('error'),
  supersededAt:    bigint('superseded_at',  { mode: 'number' }),
  supersededBy:    text('superseded_by'),
  regeneratedFrom: text('regenerated_from'),
  cancelled:       boolean('cancelled').notNull().default(false),
  attachments:     jsonb('attachments').$type<Array<{ url: string; mime: string; kind: 'image' | 'document' | 'reference'; name?: string; sizeBytes?: number }>>().notNull().default([]),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('msg_conv_idx').on(t.conversationId),
  index('msg_workspace_idx').on(t.workspaceId),
  index('msg_created_idx').on(t.createdAt),
  index('msg_superseded_idx').on(t.supersededAt),
])

// ─── Migration 0023 — Chat-driven actions ────────────────────────────────

export const chatActions = pgTable('chat_actions', {
  id:                text('id').primaryKey(),
  messageId:         text('message_id').notNull(),
  conversationId:    text('conversation_id').notNull(),
  workspaceId:       text('workspace_id').notNull(),
  actionType:        text('action_type').notNull(),
  title:             text('title').notNull(),
  summary:           text('summary').notNull(),
  payload:           jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  riskLevel:         text('risk_level').notNull().default('low'),
  status:            text('status').notNull().default('suggested'),
  executedActionId:  text('executed_action_id'),
  executedResult:    jsonb('executed_result').$type<Record<string, unknown>>(),
  decidedBy:         text('decided_by'),
  decidedAt:         bigint('decided_at', { mode: 'number' }),
  reason:            text('reason'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ca2_message_idx').on(t.messageId),
  index('ca2_workspace_idx').on(t.workspaceId),
  index('ca2_status_idx').on(t.status),
])

// ─── Migration 0024 — Brain persistence ──────────────────────────────────

export const savedViews = pgTable('saved_views', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  operatorId:      text('operator_id'),
  name:            text('name').notNull(),
  template:        text('template').notNull(),
  focusSystem:     text('focus_system'),
  cameraPosition:  jsonb('camera_position').$type<{ x: number; y: number; z: number; tx: number; ty: number; tz: number } | null>(),
  lod:             text('lod').notNull().default('systems'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('savedview_workspace_idx').on(t.workspaceId),
  index('savedview_updated_idx').on(t.updatedAt),
])

export const statusChanges = pgTable('status_changes', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  entityType:   text('entity_type').notNull(),
  entityId:     text('entity_id').notNull(),
  status:       text('status').notNull(),
  source:       text('source').notNull(),
  changedAt:    bigint('changed_at', { mode: 'number' }).notNull(),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [
  index('sch_workspace_idx').on(t.workspaceId),
  index('sch_entity_idx').on(t.entityType, t.entityId),
  index('sch_changed_idx').on(t.changedAt),
])

// ─── Migration 0025 — Platform hardening ─────────────────────────────────

export const archiveLog = pgTable('archive_log', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  tableName:          text('table_name').notNull(),
  rowsArchived:       integer('rows_archived').notNull(),
  archivedThroughTs:  bigint('archived_through_ts', { mode: 'number' }).notNull(),
  elapsedMs:          integer('elapsed_ms').notNull(),
  createdAt:          bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('al_workspace_idx').on(t.workspaceId),
  index('al_created_idx').on(t.createdAt),
])

export const notificationPrefs = pgTable('notification_prefs', {
  workspaceId:   text('workspace_id').notNull(),
  type:          text('type').notNull(),
  severityFloor: text('severity_floor').notNull().default('normal'),
  mutedUntil:    bigint('muted_until', { mode: 'number' }),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.type] }),
])

export const setupState = pgTable('setup_state', {
  workspaceId:         text('workspace_id').primaryKey(),
  firstRunAt:          bigint('first_run_at', { mode: 'number' }).notNull(),
  firstProviderAt:     bigint('first_provider_at', { mode: 'number' }),
  firstChatAt:         bigint('first_chat_at', { mode: 'number' }),
  firstActionAt:       bigint('first_action_at', { mode: 'number' }),
  firstHorizonAt:      bigint('first_horizon_at', { mode: 'number' }),
  firstProposalAt:     bigint('first_proposal_at', { mode: 'number' }),
  firstRevenueAt:      bigint('first_revenue_at', { mode: 'number' }),
  completedOnboarding: boolean('completed_onboarding').notNull().default(false),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
})

export const webhookSecrets = pgTable('webhook_secrets', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  channel:      text('channel').notNull(),
  secretHash:   text('secret_hash').notNull(),
  active:       boolean('active').notNull().default(true),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  lastUsedAt:   bigint('last_used_at', { mode: 'number' }),
}, (t) => [
  index('ws_workspace_idx').on(t.workspaceId),
  index('ws_channel_idx').on(t.channel),
])

// ─── Migration 0026 — Voice / Speech Layer ──────────────────────────────

export const speechProviderConfigs = pgTable('speech_provider_configs', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  providerId:          text('provider_id').notNull(),
  displayName:         text('display_name').notNull(),
  kind:                text('kind').notNull(),
  endpoint:            text('endpoint'),
  keyRef:              text('key_ref'),
  enabled:             boolean('enabled').notNull().default(true),
  priority:            integer('priority').notNull().default(100),
  preferredVoice:      text('preferred_voice'),
  preferredLocale:     text('preferred_locale').notNull().default('en-US'),
  maxCostPerMinUsd:    real('max_cost_per_min_usd').notNull().default(0.5),
  maxLatencyMs:        integer('max_latency_ms').notNull().default(1500),
  supportsStreaming:   boolean('supports_streaming').notNull().default(true),
  supportsInterruption: boolean('supports_interruption').notNull().default(false),
  lastHealthAt:        bigint('last_health_at', { mode: 'number' }),
  healthScore:         real('health_score').notNull().default(1.0),
  lastLatencyMs:       integer('last_latency_ms'),
  lastError:           text('last_error'),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('spc_workspace_idx').on(t.workspaceId),
  index('spc_kind_idx').on(t.kind),
])

export const voiceSessions = pgTable('voice_sessions', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  userId:              text('user_id'),
  mode:                text('mode').notNull(),
  preset:              text('preset').notNull().default('calm_operator'),
  selectedProvider:    text('selected_provider').notNull(),
  fallbackChain:       jsonb('fallback_chain').notNull().default([]),
  startedAt:           bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:             bigint('ended_at', { mode: 'number' }),
  firstAudioMs:        integer('first_audio_ms'),
  avgLatencyMs:        integer('avg_latency_ms'),
  totalCostUsd:        real('total_cost_usd').notNull().default(0),
  failoverCount:       integer('failover_count').notNull().default(0),
  blockedCommands:     integer('blocked_commands').notNull().default(0),
  transcriptRetained:  boolean('transcript_retained').notNull().default(true),
  status:              text('status').notNull().default('active'),
}, (t) => [
  index('vs_workspace_idx').on(t.workspaceId),
  index('vs_started_idx').on(t.startedAt),
  index('vs_status_idx').on(t.status),
])

export const voiceEvents = pgTable('voice_events', {
  id:           text('id').primaryKey(),
  sessionId:    text('session_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  role:         text('role'),
  text:         text('text'),
  provider:     text('provider'),
  latencyMs:    integer('latency_ms'),
  costUsd:      real('cost_usd'),
  meta:         jsonb('meta'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vev_session_idx').on(t.sessionId),
  index('vev_workspace_idx').on(t.workspaceId),
  index('vev_kind_idx').on(t.kind),
  index('vev_created_idx').on(t.createdAt),
])

// ─── Migration 0027 — Natural conversation context + feedback ──────────

export const voiceSessionContext = pgTable('voice_session_context', {
  sessionId:         text('session_id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  currentNode:       text('current_node'),
  currentTemplate:   text('current_template'),
  currentLod:        text('current_lod'),
  activeMission:     text('active_mission'),
  selectedSystem:    text('selected_system'),
  lastPlan:          jsonb('last_plan'),
  pendingPlan:       jsonb('pending_plan'),
  currentRisk:       text('current_risk').notNull().default('low'),
  currentUiMode:     text('current_ui_mode'),
  preferences:       jsonb('preferences').notNull().default({}),
  turnCount:         integer('turn_count').notNull().default(0),
  expectedNext:      jsonb('expected_next'),
  mutedUntil:        bigint('muted_until', { mode: 'number' }),
  voiceLocked:       boolean('voice_locked').notNull().default(false),
  pendingDryRunId:   text('pending_dry_run_id'),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vsc_workspace_idx').on(t.workspaceId),
  index('vsc_updated_idx').on(t.updatedAt),
])

export const workspaceVoicePrefs = pgTable('workspace_voice_prefs', {
  workspaceId:              text('workspace_id').primaryKey(),
  preferredProvider:        text('preferred_provider'),
  preferredPreset:          text('preferred_preset'),
  preferredLocale:          text('preferred_locale').notNull().default('en-US'),
  transcriptRetained:       boolean('transcript_retained').notNull().default(true),
  autoConfirmLowRisk:       boolean('auto_confirm_low_risk').notNull().default(false),
  bargeInEnabled:           boolean('barge_in_enabled').notNull().default(true),
  qualityWeight:            real('quality_weight').notNull().default(0.15),
  wakePhrases:              jsonb('wake_phrases').notNull().default(['hey novan', 'novan']),
  wakeEnabled:              boolean('wake_enabled').notNull().default(false),
  handsFreeEnabled:         boolean('hands_free_enabled').notNull().default(false),
  handsFreeAllowedIntents:  jsonb('hands_free_allowed_intents').notNull().default([]),
  ambientAlertsEnabled:     boolean('ambient_alerts_enabled').notNull().default(true),
  ambientSeverityFloor:     text('ambient_severity_floor').notNull().default('critical'),
  pushToTalkDefault:        boolean('push_to_talk_default').notNull().default(true),
  updatedAt:                bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── Migration 0030 — Voice skill memory + personalized speech ─────────

export const operatorVoicePrefs = pgTable('operator_voice_prefs', {
  workspaceId:           text('workspace_id').notNull(),
  userId:                text('user_id').notNull(),
  preferredVoice:        text('preferred_voice'),
  preferredSpeed:        real('preferred_speed').notNull().default(1.0),
  preferredLength:       text('preferred_length').notNull().default('short'),
  confirmationStyle:     text('confirmation_style').notNull().default('chip'),
  preferredWake:         text('preferred_wake'),
  preferredDefaultMode:  text('preferred_default_mode').notNull().default('push_to_talk'),
  responseMode:          text('response_mode').notNull().default('normal'),
  createdAt:             bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:             bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.userId] }),
])

export const voiceSkillObservations = pgTable('voice_skill_observations', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  userId:       text('user_id'),
  sessionId:    text('session_id'),
  kind:         text('kind').notNull(),
  phrase:       text('phrase'),
  intentKind:   text('intent_kind'),
  fromIntent:   text('from_intent'),
  toIntent:     text('to_intent'),
  confidence:   real('confidence'),
  nodeId:       text('node_id'),
  meta:         jsonb('meta'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vso_workspace_idx').on(t.workspaceId),
  index('vso_kind_idx').on(t.kind),
  index('vso_phrase_idx').on(t.phrase),
  index('vso_intent_idx').on(t.intentKind),
  index('vso_created_idx').on(t.createdAt),
])

export const voiceShortcuts = pgTable('voice_shortcuts', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  userId:       text('user_id'),
  phrase:       text('phrase').notNull(),
  expansion:    text('expansion').notNull(),
  description:  text('description'),
  useCount:     integer('use_count').notNull().default(0),
  lastUsedAt:   bigint('last_used_at', { mode: 'number' }),
  enabled:      boolean('enabled').notNull().default(true),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vsc_workspace_phrase_idx').on(t.workspaceId, t.phrase),
  index('vsc_user_idx').on(t.userId),
])

// ─── Migration 0031 — Voice dry-run simulator ──────────────────────────

export const voiceDryRuns = pgTable('voice_dry_runs', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  userId:              text('user_id'),
  sessionId:           text('session_id'),
  command:             text('command').notNull(),
  intentKind:          text('intent_kind').notNull(),
  intentTarget:        text('intent_target'),
  verdict:             text('verdict').notNull(),
  risk:                text('risk').notNull(),
  riskScore:           real('risk_score').notNull().default(0),
  estimatedCostUsd:    real('estimated_cost_usd').notNull().default(0),
  permissions:         jsonb('permissions').notNull().default([]),
  plannedSteps:        jsonb('planned_steps').notNull().default([]),
  browserPreview:      jsonb('browser_preview'),
  affectedSystems:     jsonb('affected_systems').notNull().default([]),
  blockedActions:      jsonb('blocked_actions').notNull().default([]),
  rollbackAvailable:   boolean('rollback_available').notNull().default(false),
  rollbackStrategy:    text('rollback_strategy'),
  spokenPreview:       text('spoken_preview').notNull(),
  status:              text('status').notNull().default('pending'),
  approvedViaSpoken:   boolean('approved_via_spoken').notNull().default(false),
  approvedViaUi:       boolean('approved_via_ui').notNull().default(false),
  approvedAt:          bigint('approved_at', { mode: 'number' }),
  executedAt:          bigint('executed_at', { mode: 'number' }),
  executeResult:       jsonb('execute_result'),
  rejectedReason:      text('rejected_reason'),
  executeHook:         jsonb('execute_hook'),
  budgetDecision:      jsonb('budget_decision'),
  browserActionPlan:   jsonb('browser_action_plan'),
  executedVia:         text('executed_via'),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  expiresAt:           bigint('expires_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vdr_workspace_idx').on(t.workspaceId),
  index('vdr_session_idx').on(t.sessionId),
  index('vdr_status_idx').on(t.status),
  index('vdr_created_idx').on(t.createdAt),
])

export const voiceAmbientBriefings = pgTable('voice_ambient_briefings', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  severity:     text('severity').notNull(),
  summary:      text('summary').notNull(),
  sourceEventId: text('source_event_id'),
  deliveredAt:  bigint('delivered_at', { mode: 'number' }),
  ackedAt:      bigint('acked_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vab_workspace_idx').on(t.workspaceId),
  index('vab_severity_idx').on(t.severity),
  index('vab_created_idx').on(t.createdAt),
])

export const voiceQualityFeedback = pgTable('voice_quality_feedback', {
  id:           text('id').primaryKey(),
  sessionId:    text('session_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  provider:     text('provider'),
  naturalness:  integer('naturalness'),
  speed:        integer('speed'),
  clarity:      integer('clarity'),
  tone:         integer('tone'),
  usefulness:   integer('usefulness'),
  comment:      text('comment'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vqf_workspace_idx').on(t.workspaceId),
  index('vqf_session_idx').on(t.sessionId),
  index('vqf_provider_idx').on(t.provider),
  index('vqf_created_idx').on(t.createdAt),
])

// ─── Migration 0034 — Operational intelligence primitives ───────────────

export const operatorLoadSnapshots = pgTable('operator_load_snapshots', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  userId:           text('user_id'),
  windowMs:         bigint('window_ms', { mode: 'number' }).notNull(),
  eventVolume:      integer('event_volume').notNull(),
  alertVolume:      integer('alert_volume').notNull(),
  pendingCount:     integer('pending_count').notNull(),
  interruptionRate: real('interruption_rate').notNull(),
  loadScore:        real('load_score').notNull(),
  mode:             text('mode').notNull(),
  recommendation:   text('recommendation'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ols_workspace_idx').on(t.workspaceId),
  index('ols_created_idx').on(t.createdAt),
])

export const anomalySignals = pgTable('anomaly_signals', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  severity:     text('severity').notNull(),
  score:        real('score').notNull(),
  subject:      text('subject'),
  evidence:     jsonb('evidence').notNull().default({}),
  firstSeenAt:  bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:   bigint('last_seen_at',  { mode: 'number' }).notNull(),
  occurrences:  integer('occurrences').notNull().default(1),
  ackedAt:      bigint('acked_at',     { mode: 'number' }),
  resolvedAt:   bigint('resolved_at',  { mode: 'number' }),
  createdAt:    bigint('created_at',   { mode: 'number' }).notNull(),
}, (t) => [
  index('as_workspace_idx').on(t.workspaceId),
  index('as_kind_idx').on(t.kind),
  index('as_severity_idx').on(t.severity),
  index('as_created_idx').on(t.createdAt),
])

export const selfHealActions = pgTable('self_heal_actions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  targetKind:   text('target_kind').notNull(),
  targetId:     text('target_id').notNull(),
  reason:       text('reason').notNull(),
  applied:      boolean('applied').notNull().default(false),
  result:       jsonb('result'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  appliedAt:    bigint('applied_at', { mode: 'number' }),
}, (t) => [
  index('sha_workspace_idx').on(t.workspaceId),
  index('sha_kind_idx').on(t.kind),
  index('sha_created_idx').on(t.createdAt),
])

export const cronBudgets = pgTable('cron_budgets', {
  id:            text('id').primaryKey(),
  cronName:      text('cron_name').notNull().unique(),
  windowStart:   bigint('window_start',  { mode: 'number' }).notNull(),
  callsUsed:     integer('calls_used').notNull().default(0),
  tokensUsed:    integer('tokens_used').notNull().default(0),
  costUsdUsed:   real('cost_usd_used').notNull().default(0),
  maxCalls:      integer('max_calls').notNull().default(1000),
  maxTokens:     integer('max_tokens').notNull().default(1_000_000),
  maxCostUsd:    real('max_cost_usd').notNull().default(5.0),
  windowMs:      bigint('window_ms', { mode: 'number' }).notNull().default(3_600_000),
  blocked:       boolean('blocked').notNull().default(false),
  lastBlockedAt: bigint('last_blocked_at', { mode: 'number' }),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── Business portfolio (revenue + prompt evolution) ─────────────────────
// The existing `businesses` table (line 219) holds the identity, brief,
// DNA, and metrics. The portfolio system adds:
//   • business_revenue  — append-only ledger of every $ event
//   • business_prompts  — versioned, score-tracked prompts the brain uses
// The $10k/mo per-business floor lives in businesses.metrics.monthlyTargetUsd
// (defaults to 10000 in services/business-portfolio.ts) — no schema change
// needed to track it, because we can read/write JSON into the existing
// `metrics` jsonb column without a migration.

// Append-only revenue ledger.
export const businessRevenue = pgTable('business_revenue', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  businessId:       text('business_id').notNull(),
  kind:             text('kind').notNull(),       // ad_share | sale | sponsorship | affiliate | tip | refund | other
  amountUsdCents:   bigint('amount_usd_cents', { mode: 'number' }).notNull(),
  source:           text('source'),
  sourceRef:        text('source_ref'),
  earningsMonth:    text('earnings_month').notNull(), // YYYY-MM
  landedAt:         bigint('landed_at', { mode: 'number' }),
  recordedAt:       bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('biz_rev_biz_month_idx').on(t.businessId, t.earningsMonth),
  index('biz_rev_ws_idx').on(t.workspaceId, t.recordedAt),
])

// Versioned prompt registry — the self-evolving prompt layer.
export const businessPrompts = pgTable('business_prompts', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  slot:         text('slot').notNull(),
  version:      integer('version').notNull(),
  body:         text('body').notNull(),
  uses:         integer('uses').notNull().default(0),
  scoreSum:     real('score_sum').notNull().default(0),
  lastScore:    real('last_score'),
  lastUsedAt:   bigint('last_used_at', { mode: 'number' }),
  enabled:      boolean('enabled').notNull().default(true),
  parentId:     text('parent_id'),
  origin:       text('origin').notNull().default('seed'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('biz_prompt_ws_slot_idx').on(t.workspaceId, t.slot, t.enabled),
  uniqueIndex('biz_prompt_ws_slot_version_uq').on(t.workspaceId, t.slot, t.version),
])

// ─── Business attachments — links external revenue sources to a business
//   so the portfolio system rolls up revenue + performance signals without
//   the operator manually recording every event. See migration 0047.
export const businessAttachments = pgTable('business_attachments', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  businessId:    text('business_id').notNull(),
  source:        text('source').notNull(),     // youtube_channel | etsy_shop | tiktok_account | …
  sourceRef:     text('source_ref').notNull(), // platform-stable id (NEVER the friendly name)
  label:         text('label'),
  enabled:       boolean('enabled').notNull().default(true),
  attachedAt:    bigint('attached_at',   { mode: 'number' }).notNull(),
  lastSyncedAt:  bigint('last_synced_at',{ mode: 'number' }),
  metadata:      jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:     bigint('created_at',    { mode: 'number' }).notNull(),
  updatedAt:     bigint('updated_at',    { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('bizattach_ws_biz_src_ref_uq').on(t.workspaceId, t.businessId, t.source, t.sourceRef),
  index('bizattach_ws_idx').on(t.workspaceId),
  index('bizattach_biz_idx').on(t.businessId),
  index('bizattach_src_ref_idx').on(t.source, t.sourceRef),
])

// ─── Migration 0049: Blueprint persistence ───────────────────────────────
// Portfolios (Holding-co tier), eval sets, policy rules, approved knowledge
// patterns, cartographer snapshots. Each table is workspace-scoped except
// portfolios (which group workspaces).

export const portfolios = pgTable('portfolios', {
  id:           text('id').primaryKey(),
  name:         text('name').notNull(),
  slug:         text('slug').notNull().unique(),
  description:  text('description'),
  ownerUserId:  text('owner_user_id'),
  config:       jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  archived:     boolean('archived').notNull().default(false),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
})

export const evalSets = pgTable('eval_sets', {
  id:                text('id').primaryKey(),
  workspaceId:       text('workspace_id').notNull(),
  name:              text('name').notNull(),
  description:       text('description'),
  targetSubject:     text('target_subject').notNull(),
  baselinePassRate:  real('baseline_pass_rate').notNull().default(0.80),
  tags:              text('tags').array().notNull().default([]),
  archived:          boolean('archived').notNull().default(false),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:         bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('eval_sets_ws_name_uq').on(t.workspaceId, t.name),
  index('eval_sets_workspace_idx').on(t.workspaceId),
  index('eval_sets_target_idx').on(t.targetSubject),
])

export const evalCases = pgTable('eval_cases', {
  id:                text('id').primaryKey(),
  evalSetId:         text('eval_set_id').notNull(),
  input:             text('input').notNull(),
  expectedBehavior:  text('expected_behavior').notNull(),
  tags:              text('tags').array().notNull().default([]),
  knownFailure:      boolean('known_failure').notNull().default(false),
  notes:             text('notes'),
  createdAt:         bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('eval_cases_set_idx').on(t.evalSetId),
])

export const evalRuns = pgTable('eval_runs', {
  id:           text('id').primaryKey(),
  evalSetId:    text('eval_set_id').notNull(),
  workspaceId:  text('workspace_id').notNull(),
  trigger:      text('trigger').notNull(),
  totalCases:   integer('total_cases').notNull(),
  passedCount:  integer('passed_count').notNull(),
  avgGrade:     real('avg_grade').notNull(),
  perCase:      jsonb('per_case').notNull().default([]),
  regressions:  text('regressions').array().notNull().default([]),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('eval_runs_set_idx').on(t.evalSetId, t.createdAt),
  index('eval_runs_workspace_idx').on(t.workspaceId, t.createdAt),
])

export const policyRules = pgTable('policy_rules', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  description:  text('description').notNull(),
  params:       jsonb('params').$type<Record<string, unknown>>().notNull(),
  priority:     integer('priority').notNull().default(100),
  enabled:      boolean('enabled').notNull().default(true),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('policy_rules_ws_id_uq').on(t.workspaceId, t.id),
  index('policy_rules_workspace_idx').on(t.workspaceId),
  index('policy_rules_enabled_idx').on(t.workspaceId, t.enabled),
])

export const approvedPatterns = pgTable('approved_patterns', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  source:        text('source').notNull(),
  title:         text('title').notNull(),
  description:   text('description').notNull(),
  appliesTo:     text('applies_to').array().notNull().default([]),
  evidence:      jsonb('evidence').notNull().default([]),
  confidence:    real('confidence').notNull().default(0.7),
  approvedBy:    text('approved_by').notNull(),
  approvedAt:    bigint('approved_at', { mode: 'number' }).notNull(),
  supersededBy:  text('superseded_by'),
  archived:      boolean('archived').notNull().default(false),
}, (t) => [
  index('approved_patterns_ws_idx').on(t.workspaceId),
])

export const cartographerSnapshots = pgTable('cartographer_snapshots', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  rootPath:     text('root_path').notNull(),
  fileCount:    integer('file_count').notNull(),
  snapshot:     jsonb('snapshot').notNull(),
  generatedAt:  bigint('generated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('cartographer_ws_idx').on(t.workspaceId, t.generatedAt),
])

// ─── Migration 0050 — Experiments + Hypotheses + Calibration (R146.86) ─────────
// Foundation for the brain's learning loop: every change to a business or
// platform strategy gets logged as an experiment with a falsifiable
// prediction; we measure the outcome and feed the result back into prompt
// evolution + reasoning chains. Hypotheses are the brain's own beliefs +
// the predictions that would falsify them. Calibration tracks how well
// the brain's confidence estimates match reality over time.

export const experiments = pgTable('experiments', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  businessId:     text('business_id'),
  title:          text('title').notNull(),
  hypothesis:     text('hypothesis').notNull(),
  prediction:     text('prediction').notNull(),
  metric:         text('metric').notNull(),
  baseline:       jsonb('baseline'),
  intervention:   text('intervention').notNull(),
  startAt:        bigint('start_at',  { mode: 'number' }).notNull(),
  endAt:          bigint('end_at',    { mode: 'number' }),
  status:         text('status').notNull().default('running'),
  outcome:        jsonb('outcome'),
  verdict:        text('verdict'),
  lessons:        text('lessons'),
  confidencePre:  real('confidence_pre'),
  confidencePost: real('confidence_post'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('experiments_ws_status_idx').on(t.workspaceId, t.status),
  index('experiments_business_idx').on(t.businessId),
])

export const hypotheses = pgTable('hypotheses', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  subject:         text('subject').notNull(),
  claim:           text('claim').notNull(),
  prediction:      text('prediction').notNull(),
  confidence:      real('confidence').notNull(),
  evidenceFor:     jsonb('evidence_for').notNull().default([]),
  evidenceAgainst: jsonb('evidence_against').notNull().default([]),
  status:          text('status').notNull().default('open'),
  reviewedAt:      bigint('reviewed_at', { mode: 'number' }),
  relatedChain:    text('related_chain'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('hypotheses_ws_status_idx').on(t.workspaceId, t.status),
  index('hypotheses_subject_idx').on(t.workspaceId, t.subject),
])

export const calibrationObservations = pgTable('calibration_observations', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  subjectType:        text('subject_type').notNull(),
  subjectId:          text('subject_id').notNull(),
  claimedConfidence:  real('claimed_confidence').notNull(),
  outcome:            text('outcome').notNull(),
  outcomeScore:       real('outcome_score'),
  observedAt:         bigint('observed_at', { mode: 'number' }).notNull(),
  notes:              text('notes'),
}, (t) => [
  index('calibration_ws_subject_idx').on(t.workspaceId, t.subjectType, t.observedAt),
])

// ─── Migration 0051 — Autonomy budgets (R146.97) ─────────────────────────────
// Operator sets "spend up to $X/day per business" and the brain runs
// autonomously below the ceiling, escalating only when a proposed spend
// would breach it. Without this the operator is the perpetual bottleneck
// on every spend decision regardless of size.

export const autonomyBudgets = pgTable('autonomy_budgets', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  businessId:  text('business_id'),                  // null = workspace-wide
  category:    text('category').notNull(),           // 'ads' | 'content-gen' | 'data' | 'all'
  period:      text('period').notNull(),             // 'daily' | 'weekly' | 'monthly'
  ceilingUsd:  real('ceiling_usd').notNull(),
  enabled:     boolean('enabled').notNull().default(true),
  notes:       text('notes'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('autonomy_budgets_ws_idx').on(t.workspaceId),
  index('autonomy_budgets_biz_idx').on(t.businessId),
])

export const autonomySpendLog = pgTable('autonomy_spend_log', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  businessId:  text('business_id'),
  category:    text('category').notNull(),
  amountUsd:   real('amount_usd').notNull(),
  op:          text('op').notNull(),
  reason:      text('reason'),
  recordedAt:  bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('autonomy_spend_log_ws_cat_idx').on(t.workspaceId, t.category, t.recordedAt),
  index('autonomy_spend_log_biz_idx').on(t.businessId, t.recordedAt),
])

// ─── Migration 0052 — Frontier Intelligence (R146.105) ──────────────────────
// Novan scans top AI research sources 24/7, distills breakthroughs into
// integration-ready specs, and runs ahead of competitors by prototyping
// findings before they become productized. The ledger ranks findings by
// recency × claimed impact × replicability × applicability-to-Novan-stack.
// Findings that score above a threshold spawn brain tasks automatically.

export const frontierSources = pgTable('frontier_sources', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),         // 'arxiv' | 'hf-papers' | 'github-trending' | 'rss' | 'hn' | 'paperswithcode' | 'blog'
  url:          text('url').notNull(),
  label:        text('label').notNull(),
  enabled:      boolean('enabled').notNull().default(true),
  lastScannedAt: bigint('last_scanned_at', { mode: 'number' }),
  scanIntervalSec: integer('scan_interval_sec').notNull().default(3600),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('frontier_sources_ws_idx').on(t.workspaceId, t.enabled),
])

export const frontierFindings = pgTable('frontier_findings', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  sourceId:           text('source_id'),
  externalUrl:        text('external_url').notNull(),
  externalId:         text('external_id'),        // arxiv-id, github-repo, etc — for dedup
  title:              text('title').notNull(),
  authors:            text('authors'),
  publishedAt:        bigint('published_at', { mode: 'number' }),
  discoveredAt:       bigint('discovered_at', { mode: 'number' }).notNull(),
  rawAbstract:        text('raw_abstract'),
  // LLM distillation
  technique:          text('technique'),          // canonical name
  claimedCapability:  text('claimed_capability'), // what new ability
  noveltyVsSOTA:      text('novelty_vs_sota'),
  replicabilityNote:  text('replicability_note'),
  integrationVector:  text('integration_vector'), // how it plugs into Novan
  // Scoring (0-100 each)
  scoreRecency:       integer('score_recency').notNull().default(0),
  scoreImpact:        integer('score_impact').notNull().default(0),
  scoreReplicability: integer('score_replicability').notNull().default(0),
  scoreApplicability: integer('score_applicability').notNull().default(0),
  scoreComposite:     integer('score_composite').notNull().default(0),
  // Lifecycle
  status:             text('status').notNull().default('new'), // new | distilled | queued | prototyping | integrated | rejected
  prototypeTaskId:    text('prototype_task_id'),
  integratedAt:       bigint('integrated_at', { mode: 'number' }),
  rejectedReason:     text('rejected_reason'),
  // For semantic recall + dedup
  embedding:          vector('embedding', { dimensions: 1536 }),
  createdAt:          bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('frontier_findings_ws_status_idx').on(t.workspaceId, t.status, t.scoreComposite),
  index('frontier_findings_ws_pub_idx').on(t.workspaceId, t.publishedAt),
  uniqueIndex('frontier_findings_ws_extid_idx').on(t.workspaceId, t.externalId),
])

export const frontierAdvances = pgTable('frontier_advances', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  findingId:    text('finding_id').notNull(),
  ahead:        text('ahead').notNull(),    // 'integrated' | 'prototyped' | 'specced'
  monthsAhead:  real('months_ahead').notNull().default(0),
  notes:        text('notes'),
  recordedAt:   bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('frontier_advances_ws_idx').on(t.workspaceId, t.recordedAt),
])

// ─── Migration 0053 — Frontier MAX (R146.107) ────────────────────────────
// Capability catalog: every AI system Novan learns about, builds, and
// permanently advances. Status transitions:
//   unknown → learning → basics_known → integrated → advancing → permanent
// Once a capability is 'permanent', advancement cycles propose realism /
// efficiency / quality improvements on a continuous loop.

export const frontierCapabilities = pgTable('frontier_capabilities', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  name:                text('name').notNull(),         // canonical, e.g. 'svd-img2vid', 'speculative-decoding'
  category:            text('category').notNull(),     // 'video-gen' | 'image-gen' | 'llm-reasoning' | 'retrieval' | 'audio' | 'agent' | 'training' | 'other'
  status:              text('status').notNull().default('unknown'),
  description:         text('description'),
  upstreamFindingIds:  jsonb('upstream_finding_ids').$type<string[]>(),
  integrationPath:     text('integration_path'),       // service file or op
  currentVersion:      integer('current_version').notNull().default(0),
  realismScore:        integer('realism_score').notNull().default(0),     // 0-100, only meaningful for media gen
  qualityScore:        integer('quality_score').notNull().default(0),     // 0-100
  efficiencyScore:     integer('efficiency_score').notNull().default(0),  // 0-100
  lastAdvancedAt:      bigint('last_advanced_at', { mode: 'number' }),
  advancementCount:    integer('advancement_count').notNull().default(0),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('frontier_capabilities_ws_name_idx').on(t.workspaceId, t.name),
  index('frontier_capabilities_ws_status_idx').on(t.workspaceId, t.status),
  index('frontier_capabilities_ws_cat_idx').on(t.workspaceId, t.category),
])

export const frontierAdvancements = pgTable('frontier_advancements', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  capabilityId:     text('capability_id').notNull(),
  proposedAt:       bigint('proposed_at', { mode: 'number' }).notNull(),
  kind:             text('kind').notNull(),        // 'realism' | 'efficiency' | 'quality' | 'scope'
  proposal:         text('proposal'),
  expectedGain:     integer('expected_gain').notNull().default(0),  // 0-100
  appliedAt:        bigint('applied_at', { mode: 'number' }),
  appliedNotes:     text('applied_notes'),
  realismBefore:    integer('realism_before'),
  realismAfter:     integer('realism_after'),
  qualityBefore:    integer('quality_before'),
  qualityAfter:     integer('quality_after'),
  efficiencyBefore: integer('efficiency_before'),
  efficiencyAfter:  integer('efficiency_after'),
}, (t) => [
  index('frontier_advancements_ws_cap_idx').on(t.workspaceId, t.capabilityId, t.proposedAt),
])

export const frontierSettings = pgTable('frontier_settings', {
  workspaceId:        text('workspace_id').primaryKey(),
  maxMode:            boolean('max_mode').notNull().default(false),
  scanIntervalMs:     integer('scan_interval_ms').notNull().default(300_000),
  distillBatchSize:   integer('distill_batch_size').notNull().default(8),
  prototypeBatchSize: integer('prototype_batch_size').notNull().default(3),
  advanceBatchSize:   integer('advance_batch_size').notNull().default(3),
  parallelSources:    integer('parallel_sources').notNull().default(3),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── Migration 0054 — Second Brain (R146.114) ───────────────────────────
// cryptocita-style 4-step wiki pipeline:
//   1. drop  → operator (or any integration) drops sources into `second_brain_raw`
//   2. extract → cron compiles raw rows into `second_brain_articles` (wiki notes)
//   3. direct → CLAUDE.md-style rules live in `second_brain_config.rules_md`
//   4. automate → daily ingest + daily review + weekly audit crons

export const secondBrainRaw = pgTable('second_brain_raw', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  source:       text('source').notNull(),        // 'url' | 'video' | 'text' | 'file'
  url:          text('url'),
  title:        text('title'),
  content:      text('content'),                 // raw text body (article body, transcript, etc.)
  tagsHint:     text('tags_hint'),               // operator-supplied hint (optional)
  status:       text('status').notNull().default('queued'),  // queued | compiled | failed | discarded
  compiledAt:   bigint('compiled_at', { mode: 'number' }),
  compileError: text('compile_error'),
  articleIds:   jsonb('article_ids').$type<string[]>(),       // wiki articles created from this raw item
  droppedAt:    bigint('dropped_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sb_raw_ws_status_idx').on(t.workspaceId, t.status, t.droppedAt),
])

export const secondBrainArticles = pgTable('second_brain_articles', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  topic:        text('topic').notNull(),          // e.g. 'ai-agents', 'video-generation'
  slug:         text('slug').notNull(),           // file-name-style id
  title:        text('title').notNull(),
  body:         text('body').notNull(),           // markdown
  keyTakeaways: jsonb('key_takeaways').$type<string[]>(),
  links:        jsonb('links').$type<Array<{ to: string; label: string }>>(),
  sourceRawIds: jsonb('source_raw_ids').$type<string[]>(),
  embedding:    vector('embedding', { dimensions: 1536 }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('sb_articles_ws_topic_slug_idx').on(t.workspaceId, t.topic, t.slug),
  index('sb_articles_ws_topic_idx').on(t.workspaceId, t.topic, t.updatedAt),
])

export const secondBrainConfig = pgTable('second_brain_config', {
  workspaceId:        text('workspace_id').primaryKey(),
  rulesMd:            text('rules_md').notNull().default(''),  // CLAUDE.md content
  dailyIngestHour:    integer('daily_ingest_hour').notNull().default(7),
  dailyReviewHour:    integer('daily_review_hour').notNull().default(18),
  weeklyAuditDay:     integer('weekly_audit_day').notNull().default(0),     // 0=Sun
  weeklyAuditHour:    integer('weekly_audit_hour').notNull().default(9),
  enabled:            boolean('enabled').notNull().default(true),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
})

export const secondBrainReviews = pgTable('second_brain_reviews', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  kind:        text('kind').notNull(),       // 'daily-ingest' | 'daily-review' | 'weekly-audit'
  summary:     text('summary'),
  changedArticleIds: jsonb('changed_article_ids').$type<string[]>(),
  gaps:        jsonb('gaps').$type<string[]>(),
  brokenLinks: jsonb('broken_links').$type<string[]>(),
  runAt:       bigint('run_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sb_reviews_ws_kind_idx').on(t.workspaceId, t.kind, t.runAt),
])

// ─── Migration 0055 — Build batch (R146.115) ───────────────────────────
// chriswesst War Room + yngsoren EasySlice YT→shorts + robthebank $1M
// brand launch + mavgpt viral-style scripts + ChatGPT export import.

export const agentRoster = pgTable('agent_roster', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  shortName:    text('short_name').notNull(),
  role:         text('role').notNull(),
  avatarHue:    integer('avatar_hue').notNull().default(180),
  status:       text('status').notNull().default('idle'),
  currentTask:  text('current_task'),
  lastActiveAt: bigint('last_active_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('agent_roster_ws_short_idx').on(t.workspaceId, t.shortName),
  index('agent_roster_ws_status_idx').on(t.workspaceId, t.status),
])

export const agentOpsBoard = pgTable('agent_ops_board', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  title:        text('title').notNull(),
  ownerAgentId: text('owner_agent_id'),
  column:       text('column').notNull().default('on_deck'),
  dueAt:        bigint('due_at', { mode: 'number' }),
  notes:        text('notes'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ops_board_ws_col_idx').on(t.workspaceId, t.column, t.updatedAt),
])

export const shortformPipelines = pgTable('shortform_pipelines', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  sourceUrl:     text('source_url').notNull(),
  sourceTitle:   text('source_title'),
  targetAccounts: jsonb('target_accounts').$type<Array<{ platform: 'tiktok' | 'instagram' | 'youtube' | 'facebook'; handle: string; connectorAccountId?: string }>>(),
  styleProfile:  jsonb('style_profile').$type<Record<string, unknown>>(),
  enabled:       boolean('enabled').notNull().default(true),
  // R146.116 — must be flipped to true by the operator before the auto-poster
  // sends OPERATOR_APPROVED publishes through IG/TikTok/YT connectors.
  autoPostApproved: boolean('auto_post_approved').notNull().default(false),
  lastCheckedAt: bigint('last_checked_at', { mode: 'number' }),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sf_pipelines_ws_idx').on(t.workspaceId, t.enabled),
])

export const shortformClips = pgTable('shortform_clips', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  pipelineId:      text('pipeline_id').notNull(),
  sourceVideoUrl:  text('source_video_url').notNull(),
  sourceVideoTitle: text('source_video_title'),
  startSec:        real('start_sec').notNull(),
  endSec:          real('end_sec').notNull(),
  hook:            text('hook'),
  viralScore:      integer('viral_score').notNull().default(0),
  rationale:       text('rationale'),
  outputPath:      text('output_path'),
  outputUrl:       text('output_url'),
  postedTo:        jsonb('posted_to').$type<Array<{ platform: string; postId?: string; postedAt: number }>>(),
  status:          text('status').notNull().default('queued'),
  error:           text('error'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('sf_clips_ws_status_idx').on(t.workspaceId, t.status, t.createdAt),
  index('sf_clips_pipeline_idx').on(t.pipelineId, t.createdAt),
])

export const viralStyleScripts = pgTable('viral_style_scripts', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  sourceUrl:    text('source_url').notNull(),
  sourceTitle:  text('source_title'),
  rank:         integer('rank').notNull(),
  title:        text('title').notNull(),
  body:         text('body').notNull(),
  tags:         jsonb('tags').$type<string[]>(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('vss_ws_source_idx').on(t.workspaceId, t.sourceUrl, t.rank),
])

export const businessLaunches = pgTable('business_launches', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  ideaSeed:     text('idea_seed').notNull(),
  problemStatement: text('problem_statement'),
  validationNotes:  text('validation_notes'),
  brandName:    text('brand_name'),
  brandPalette: jsonb('brand_palette').$type<string[]>(),
  mockupUrls:   jsonb('mockup_urls').$type<string[]>(),
  landingPageHtml: text('landing_page_html'),
  landingPageUrl:  text('landing_page_url'),
  waitlistFormUrl: text('waitlist_form_url'),
  prelaunchContentPlan: jsonb('prelaunch_content_plan').$type<Array<{ day: number; channel: string; angle: string }>>(),
  currentStage: text('current_stage').notNull().default('validation'),
  stageHistory: jsonb('stage_history').$type<Array<{ stage: string; at: number; summary?: string }>>(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('bl_ws_stage_idx').on(t.workspaceId, t.currentStage, t.updatedAt),
])

export const chatgptImports = pgTable('chatgpt_imports', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  source:       text('source').notNull(),
  filePath:     text('file_path').notNull(),
  conversationCount: integer('conversation_count').notNull().default(0),
  ideasExtracted: integer('ideas_extracted').notNull().default(0),
  status:       text('status').notNull().default('processing'),
  importedAt:   bigint('imported_at', { mode: 'number' }).notNull(),
})

export const extractedBusinessIdeas = pgTable('extracted_business_ideas', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  importId:     text('import_id'),
  source:       text('source').notNull(),
  title:        text('title').notNull(),
  pitch:        text('pitch').notNull(),
  problem:      text('problem'),
  audience:     text('audience'),
  revenueModel: text('revenue_model'),
  feasibilityScore: integer('feasibility_score').notNull().default(0),
  conversationRef: text('conversation_ref'),
  status:       text('status').notNull().default('proposed'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ebi_ws_score_idx').on(t.workspaceId, t.feasibilityScore, t.createdAt),
])

// ─── R146.128 — Tier 1 safety bundle ───────────────────────────────────

export const spendCaps = pgTable('spend_caps', {
  workspaceId:    text('workspace_id').primaryKey(),
  dailyUsdCap:    real('daily_usd_cap').notNull().default(50),
  monthlyUsdCap:  real('monthly_usd_cap').notNull().default(500),
  hardBlock:      boolean('hard_block').notNull().default(true),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
  updatedBy:      text('updated_by').notNull().default('system'),
})

export const moderationResults = pgTable('moderation_results', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  contentType:     text('content_type').notNull(),
  contentRefId:    text('content_ref_id'),
  contentHash:     text('content_hash').notNull(),
  verdict:         text('verdict').notNull(),
  reasons:         jsonb('reasons').$type<string[]>().notNull().default([]),
  categoryScores:  jsonb('category_scores').$type<Record<string, number>>().notNull().default({}),
  reviewer:        text('reviewer').notNull(),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('mod_ws_idx').on(t.workspaceId, t.createdAt),
  index('mod_ref_idx').on(t.contentRefId),
])

export const backupRuns = pgTable('backup_runs', {
  id:           text('id').primaryKey(),
  startedAt:    bigint('started_at',  { mode: 'number' }).notNull(),
  finishedAt:   bigint('finished_at', { mode: 'number' }),
  status:       text('status').notNull(),
  destination:  text('destination').notNull(),
  sizeBytes:    bigint('size_bytes',  { mode: 'number' }),
  error:        text('error'),
}, (t) => [
  index('bk_started_idx').on(t.startedAt),
])

// ─── R146.129 — Revenue execution loop ──────────────────────────────────

export const revenueRuns = pgTable('revenue_runs', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  ideaTitle:       text('idea_title').notNull(),
  ideaPitch:       text('idea_pitch').notNull(),
  currentStep:     text('current_step').notNull().default('idea'),
  // idea → scored → feasibility_pass | feasibility_fail → business_created → channels_proposed → content_drafted → moderation_pass | moderation_blocked → published | halted
  status:          text('status').notNull().default('running'),
  // running | awaiting_approval | completed | halted | failed
  businessId:      text('business_id'),
  channelIds:      jsonb('channel_ids').$type<string[]>().notNull().default([]),
  contentIds:      jsonb('content_ids').$type<string[]>().notNull().default([]),
  scores:          jsonb('scores').$type<Record<string, unknown>>().notNull().default({}),
  feasibility:     jsonb('feasibility').$type<Record<string, unknown>>().notNull().default({}),
  haltReason:      text('halt_reason'),
  approvalsPending: jsonb('approvals_pending').$type<string[]>().notNull().default([]),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:       bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rr_ws_idx').on(t.workspaceId, t.createdAt),
  index('rr_status_idx').on(t.workspaceId, t.status, t.currentStep),
])

// ─── R146.130 — Tier 2 batch ────────────────────────────────────────────

export const operatorDecisions = pgTable('operator_decisions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  subjectType:  text('subject_type').notNull(),
  subjectId:    text('subject_id').notNull(),
  decision:     text('decision').notNull(),
  reason:       text('reason'),
  features:     jsonb('features').$type<Record<string, unknown>>().notNull().default({}),
  decidedBy:    text('decided_by').notNull().default('operator'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('od_ws_subj_idx').on(t.workspaceId, t.subjectType, t.createdAt),
  index('od_subj_idx').on(t.subjectType, t.subjectId),
])

export const promptAbTrials = pgTable('prompt_ab_trials', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  promptKey:      text('prompt_key').notNull(),
  variantA:       text('variant_a').notNull(),
  variantB:       text('variant_b').notNull(),
  samplesTarget:  integer('samples_target').notNull().default(20),
  samplesDone:    integer('samples_done').notNull().default(0),
  winsA:          integer('wins_a').notNull().default(0),
  winsB:          integer('wins_b').notNull().default(0),
  ties:           integer('ties').notNull().default(0),
  status:         text('status').notNull().default('running'),
  winner:         text('winner'),
  startedAt:      bigint('started_at',   { mode: 'number' }).notNull(),
  completedAt:    bigint('completed_at', { mode: 'number' }),
}, (t) => [
  index('pab_ws_idx').on(t.workspaceId, t.startedAt),
  index('pab_status_idx').on(t.workspaceId, t.status),
])

// ─── R146.131 — platform quotas + attribution ──────────────────────────

export const platformQuotaUsage = pgTable('platform_quota_usage', {
  workspaceId:  text('workspace_id').notNull(),
  platform:     text('platform').notNull(),
  bucketDay:    text('bucket_day').notNull(),
  action:       text('action').notNull(),
  count:        integer('count').notNull().default(0),
  dailyCap:     integer('daily_cap').notNull().default(25),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.platform, t.bucketDay, t.action] }),
  index('pqu_ws_day_idx').on(t.workspaceId, t.bucketDay),
])

export const attributionEdges = pgTable('attribution_edges', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  srcType:      text('src_type').notNull(),
  srcId:        text('src_id').notNull(),
  dstType:      text('dst_type').notNull(),
  dstId:        text('dst_id').notNull(),
  relation:     text('relation').notNull(),
  weight:       real('weight').notNull().default(1.0),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ae_src_idx').on(t.workspaceId, t.srcType, t.srcId),
  index('ae_dst_idx').on(t.workspaceId, t.dstType, t.dstId),
  index('ae_rel_idx').on(t.workspaceId, t.relation),
])

// ─── R146.132 — cross-account planner + LLM drift ──────────────────────

export const accountNiches = pgTable('account_niches', {
  workspaceId:          text('workspace_id').notNull(),
  connectorAccountId:   text('connector_account_id').notNull(),
  nicheTags:            jsonb('niche_tags').$type<string[]>().notNull().default([]),
  postingSlots:         jsonb('posting_slots').$type<number[]>().notNull().default([]),
  updatedAt:            bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.connectorAccountId] }),
])

export const llmOutputFingerprints = pgTable('llm_output_fingerprints', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  promptKey:     text('prompt_key').notNull(),
  provider:      text('provider').notNull(),
  model:         text('model').notNull(),
  shapeHash:     text('shape_hash').notNull(),
  shapeSample:   jsonb('shape_sample').$type<Record<string, unknown>>().notNull().default({}),
  observedAt:    bigint('observed_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('llm_fp_key_idx').on(t.workspaceId, t.promptKey, t.observedAt),
  index('llm_fp_shape_idx').on(t.workspaceId, t.promptKey, t.shapeHash),
])

// ─── R146.134 — POD mass production ────────────────────────────────────

export const podBatchRuns = pgTable('pod_batch_runs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  niche:          text('niche').notNull(),
  designStyle:    text('design_style').notNull().default('modern minimal'),
  targetCount:    integer('target_count').notNull().default(20),
  productTypes:   jsonb('product_types').$type<string[]>().notNull().default([]),
  stores:         jsonb('stores').$type<string[]>().notNull().default([]),
  status:         text('status').notNull().default('running'),
  generatedCount: integer('generated_count').notNull().default(0),
  listedCount:    integer('listed_count').notNull().default(0),
  failedCount:    integer('failed_count').notNull().default(0),
  totalCostUsd:   real('total_cost_usd').notNull().default(0),
  haltReason:     text('halt_reason'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pbr_ws_idx').on(t.workspaceId, t.createdAt),
  index('pbr_status_idx').on(t.workspaceId, t.status),
])

export const podBatchItems = pgTable('pod_batch_items', {
  id:             text('id').primaryKey(),
  batchId:        text('batch_id').notNull(),
  workspaceId:    text('workspace_id').notNull(),
  designPrompt:   text('design_prompt').notNull(),
  productType:    text('product_type').notNull(),
  imageUrl:       text('image_url'),
  imageGenId:     text('image_gen_id'),
  title:          text('title'),
  description:    text('description'),
  listedStores:   jsonb('listed_stores').$type<Array<{ store: string; productId: string; listedAt: number }>>().notNull().default([]),
  status:         text('status').notNull().default('queued'),
  error:          text('error'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pbi_batch_idx').on(t.batchId, t.status),
  index('pbi_ws_idx').on(t.workspaceId, t.createdAt),
])

// ─── R146.135 — S-tier features ────────────────────────────────────────

export const twinSimRuns = pgTable('twin_sim_runs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  targetRunType:  text('target_run_type').notNull(),
  targetInput:    jsonb('target_input').$type<Record<string, unknown>>().notNull().default({}),
  horizonDays:    integer('horizon_days').notNull().default(30),
  projected:      jsonb('projected').$type<Record<string, unknown>>().notNull().default({}),
  recommendation: text('recommendation').notNull().default('review'),
  reasoning:      jsonb('reasoning').$type<string[]>().notNull().default([]),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('tsr_ws_idx').on(t.workspaceId, t.createdAt)])

export const speculativeTests = pgTable('speculative_tests', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  baseClipId:     text('base_clip_id'),
  variants:       jsonb('variants').$type<Array<{ label: string; hook: string; platform: string; postId?: string; metrics?: Record<string, number> }>>().notNull().default([]),
  burnerMinutes:  integer('burner_minutes').notNull().default(60),
  status:         text('status').notNull().default('running'),
  winnerLabel:    text('winner_label'),
  promotedTo:     text('promoted_to'),
  startedAt:      bigint('started_at', { mode: 'number' }).notNull(),
  scoredAt:       bigint('scored_at',  { mode: 'number' }),
}, (t) => [index('st_ws_idx').on(t.workspaceId, t.startedAt)])

export const taskAuctions = pgTable('task_auctions', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  taskType:       text('task_type').notNull(),
  taskPayload:    jsonb('task_payload').$type<Record<string, unknown>>().notNull().default({}),
  bids:           jsonb('bids').$type<Array<{ agentId: string; costUsd: number; confidence: number; etaSec: number; score: number }>>().notNull().default([]),
  winnerAgentId:  text('winner_agent_id'),
  status:         text('status').notNull().default('open'),
  openedAt:       bigint('opened_at',  { mode: 'number' }).notNull(),
  awardedAt:      bigint('awarded_at', { mode: 'number' }),
  executedAt:     bigint('executed_at',{ mode: 'number' }),
  result:         jsonb('result').$type<Record<string, unknown>>(),
}, (t) => [
  index('ta_ws_idx').on(t.workspaceId, t.openedAt),
  index('ta_status_idx').on(t.workspaceId, t.status),
])

export const constitutionalAudits = pgTable('constitutional_audits', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  auditKind:      text('audit_kind').notNull(),
  missionDrift:   real('mission_drift').notNull().default(0),
  manipulation:   real('manipulation').notNull().default(0),
  scopeCreep:     real('scope_creep').notNull().default(0),
  findings:       jsonb('findings').$type<string[]>().notNull().default([]),
  remediation:    jsonb('remediation').$type<string[]>().notNull().default([]),
  auditedAt:      bigint('audited_at', { mode: 'number' }).notNull(),
}, (t) => [index('ca_ws_idx').on(t.workspaceId, t.auditedAt)])

export const funnelSimulations = pgTable('funnel_simulations', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  targetUsdMo:    real('target_usd_mo').notNull(),
  horizonMonths:  integer('horizon_months').notNull(),
  paths:          jsonb('paths').$type<Array<{ label: string; probability: number; monthlyTrajectory: number[]; gates: string[] }>>().notNull().default([]),
  recommended:    text('recommended'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('fs_ws_idx').on(t.workspaceId, t.createdAt)])

// ─── R146.136 — A-tier features ───────────────────────────────────────

export const distillationDatasets = pgTable('distillation_datasets', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  sampleCount:  integer('sample_count').notNull().default(0),
  jsonlPath:    text('jsonl_path'),
  status:       text('status').notNull().default('pending'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('dd_ws_idx').on(t.workspaceId, t.createdAt)])

export const realityDiffs = pgTable('reality_diffs', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  source:       text('source').notNull(),
  expected:     jsonb('expected').$type<Record<string, unknown>>().notNull().default({}),
  actual:       jsonb('actual').$type<Record<string, unknown>>().notNull().default({}),
  divergence:   real('divergence').notNull().default(0),
  resolved:     boolean('resolved').notNull().default(false),
  observedAt:   bigint('observed_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rd_ws_idx').on(t.workspaceId, t.observedAt),
  index('rd_open_idx').on(t.workspaceId, t.resolved),
])

export const anomalyHypotheses = pgTable('anomaly_hypotheses', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  metric:        text('metric').notNull(),
  observedValue: real('observed_value').notNull(),
  expectedValue: real('expected_value').notNull(),
  hypotheses:    jsonb('hypotheses').$type<Array<{ name: string; prior: number; costToVerify: number; status: string }>>().notNull().default([]),
  status:        text('status').notNull().default('open'),
  investigatedFirst: text('investigated_first'),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('ah_ws_idx').on(t.workspaceId, t.createdAt)])

export const sponsorshipOutreach = pgTable('sponsorship_outreach', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  channelId:        text('channel_id'),
  prospectBrand:    text('prospect_brand').notNull(),
  audienceOverlap:  real('audience_overlap').notNull().default(0),
  draftDm:          text('draft_dm'),
  rateProposed:     real('rate_proposed'),
  status:           text('status').notNull().default('drafted'),
  sentAt:           bigint('sent_at', { mode: 'number' }),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('so_ws_idx').on(t.workspaceId, t.createdAt)])

export const autoDocs = pgTable('auto_docs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  docKind:        text('doc_kind').notNull(),
  bodyMd:         text('body_md').notNull(),
  generatedFrom:  jsonb('generated_from').$type<string[]>().notNull().default([]),
  supersededBy:   text('superseded_by'),
  generatedAt:    bigint('generated_at', { mode: 'number' }).notNull(),
}, (t) => [index('ad_ws_kind_idx').on(t.workspaceId, t.docKind, t.generatedAt)])

// ─── R146.137 — B-tier features ────────────────────────────────────────

export const injectionScans = pgTable('injection_scans', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  source:       text('source').notNull(),
  sourceRef:    text('source_ref'),
  verdict:      text('verdict').notNull(),
  matched:      jsonb('matched').$type<string[]>().notNull().default([]),
  contentHash:  text('content_hash').notNull(),
  scannedAt:    bigint('scanned_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('is_ws_idx').on(t.workspaceId, t.scannedAt),
  index('is_verdict_idx').on(t.workspaceId, t.verdict, t.scannedAt),
])

export const redteamRuns = pgTable('redteam_runs', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  attacks:         jsonb('attacks').$type<Array<{ name: string; target: string; vector: string; result: string }>>().notNull().default([]),
  vulnerabilities: integer('vulnerabilities').notNull().default(0),
  status:          text('status').notNull().default('running'),
  startedAt:       bigint('started_at',  { mode: 'number' }).notNull(),
  finishedAt:      bigint('finished_at', { mode: 'number' }),
}, (t) => [index('rt_ws_idx').on(t.workspaceId, t.startedAt)])

export const contentProvenance = pgTable('content_provenance', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  postId:      text('post_id'),
  clipId:      text('clip_id'),
  manifest:    jsonb('manifest').$type<Record<string, unknown>>().notNull(),
  signature:   text('signature').notNull(),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('cp_post_idx').on(t.postId),
  index('cp_clip_idx').on(t.clipId),
])

export const skillRoi = pgTable('skill_roi', {
  workspaceId:           text('workspace_id').notNull(),
  opName:                text('op_name').notNull(),
  calls:                 integer('calls').notNull().default(0),
  costUsdTotal:          real('cost_usd_total').notNull().default(0),
  revenueAttributedUsd:  real('revenue_attributed_usd').notNull().default(0),
  lastCallAt:            bigint('last_call_at', { mode: 'number' }),
  updatedAt:             bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.opName] })])

export const agentDemotions = pgTable('agent_demotions', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  agentId:        text('agent_id').notNull(),
  reason:         text('reason').notNull(),
  costPerTask:    real('cost_per_task'),
  valuePerTask:   real('value_per_task'),
  action:         text('action').notNull(),
  decidedAt:      bigint('decided_at', { mode: 'number' }).notNull(),
}, (t) => [index('ad_ws_agent_idx').on(t.workspaceId, t.agentId, t.decidedAt)])

// ─── R146.138 — C-tier features ────────────────────────────────────────

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId:  text('workspace_id').notNull(),
  userId:       text('user_id').notNull(),
  role:         text('role').notNull(),
  scope:        jsonb('scope').$type<string[]>().notNull().default([]),
  invitedBy:    text('invited_by'),
  joinedAt:     bigint('joined_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })])

export const negotiations = pgTable('negotiations', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  counterparty:  text('counterparty').notNull(),
  topic:         text('topic').notNull(),
  positionOpen:  jsonb('position_open').$type<Record<string, unknown>>().notNull().default({}),
  positionWalk:  jsonb('position_walk').$type<Record<string, unknown>>().notNull().default({}),
  batna:         text('batna'),
  transcript:    jsonb('transcript').$type<Array<{ role: string; content: string; at: number }>>().notNull().default([]),
  status:        text('status').notNull().default('drafted'),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('neg_ws_idx').on(t.workspaceId, t.createdAt)])

export const a2aContracts = pgTable('a2a_contracts', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  peerWorkspace:  text('peer_workspace').notNull(),
  capability:     text('capability').notNull(),
  revenueSplit:   real('revenue_split').notNull().default(0.5),
  status:         text('status').notNull().default('proposed'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('a2a_ws_idx').on(t.workspaceId, t.createdAt)])

export const calendarSignals = pgTable('calendar_signals', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  signalDate:      text('signal_date').notNull(),
  energyLevel:     text('energy_level').notNull(),
  predictedLoad:   integer('predicted_load').notNull().default(0),
  recommendations: jsonb('recommendations').$type<string[]>().notNull().default([]),
  recordedAt:      bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [index('cs_ws_date_idx').on(t.workspaceId, t.signalDate)])

export const commitments = pgTable('commitments', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  statement:     text('statement').notNull(),
  deadlineAt:    bigint('deadline_at', { mode: 'number' }).notNull(),
  forfeitUsd:    real('forfeit_usd').notNull().default(0),
  forfeitTo:     text('forfeit_to'),
  signature:     text('signature').notNull(),
  status:        text('status').notNull().default('active'),
  resolvedAt:    bigint('resolved_at', { mode: 'number' }),
  createdAt:     bigint('created_at',  { mode: 'number' }).notNull(),
}, (t) => [
  index('cm_ws_idx').on(t.workspaceId, t.createdAt),
  index('cm_due_idx').on(t.workspaceId, t.status, t.deadlineAt),
])

// ─── R146.139 — AI foundation: semantic memory + eval ──────────────────

export const memoryChunks = pgTable('memory_chunks', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  content:         text('content').notNull(),
  sourceType:      text('source_type').notNull(),
  sourceId:        text('source_id'),
  metadata:        jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  embedding:       vector('embedding', { dimensions: 768 }),
  pinned:          boolean('pinned').notNull().default(false),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  accessedCount:   integer('accessed_count').notNull().default(0),
  lastAccessedAt:  bigint('last_accessed_at', { mode: 'number' }),
}, (t) => [
  index('mc_ws_idx').on(t.workspaceId, t.createdAt),
  index('mc_pinned_idx').on(t.workspaceId, t.pinned),
])

export const promptEvalCases = pgTable('prompt_eval_cases', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  promptKey:    text('prompt_key').notNull(),
  input:        jsonb('input').$type<Record<string, unknown>>().notNull(),
  expected:     jsonb('expected').$type<Record<string, unknown>>(),
  rubric:       text('rubric'),
  weight:       real('weight').notNull().default(1.0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('pec_key_idx').on(t.workspaceId, t.promptKey)])

export const promptEvalRuns = pgTable('prompt_eval_runs', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  promptKey:     text('prompt_key').notNull(),
  promptVersion: text('prompt_version'),
  casesTotal:    integer('cases_total').notNull().default(0),
  casesPassed:   integer('cases_passed').notNull().default(0),
  score:         real('score').notNull().default(0),
  details:       jsonb('details').$type<Array<{ caseId: string; passed: boolean; actual: unknown; reason: string }>>().notNull().default([]),
  ranAt:         bigint('ran_at', { mode: 'number' }).notNull(),
}, (t) => [index('per_key_idx').on(t.workspaceId, t.promptKey, t.ranAt)])

// ─── R146.140 — AI A-tier ──────────────────────────────────────────────

export const inferenceCache = pgTable('inference_cache', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  promptHash:       text('prompt_hash').notNull(),
  promptEmbedding:  vector('prompt_embedding', { dimensions: 768 }),
  response:         text('response').notNull(),
  taskType:         text('task_type').notNull(),
  provider:         text('provider').notNull(),
  hitCount:         integer('hit_count').notNull().default(0),
  createdAt:        bigint('created_at',  { mode: 'number' }).notNull(),
  lastHitAt:        bigint('last_hit_at', { mode: 'number' }),
}, (t) => [
  index('ic_ws_idx').on(t.workspaceId, t.createdAt),
  index('ic_hash_idx').on(t.workspaceId, t.promptHash),
])

export const promptTemplatesV2 = pgTable('prompt_templates_v2', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  name:         text('name').notNull(),
  version:      integer('version').notNull().default(1),
  body:         text('body').notNull(),
  inputSchema:  jsonb('input_schema').$type<Record<string, unknown>>().notNull().default({}),
  outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
  active:       boolean('active').notNull().default(true),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ptv2_ws_idx').on(t.workspaceId, t.name),
  index('ptv2_active_idx').on(t.workspaceId, t.active),
])

// ─── R146.141 — AI B-tier ──────────────────────────────────────────────

export const agentDebates = pgTable('agent_debates', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  question:      text('question').notNull(),
  participants:  jsonb('participants').$type<Array<{ name: string; prior: string }>>().notNull().default([]),
  rounds:        jsonb('rounds').$type<Array<Array<{ name: string; content: string }>>>().notNull().default([]),
  synthesis:     text('synthesis'),
  confidence:    real('confidence'),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('adb_ws_idx').on(t.workspaceId, t.createdAt)])

export const operatorProfile = pgTable('operator_profile', {
  workspaceId:  text('workspace_id').primaryKey(),
  facts:        jsonb('facts').$type<Array<{ key: string; value: string; pinnedAt: number }>>().notNull().default([]),
  preferences:  jsonb('preferences').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
})

export const syntheticDataRuns = pgTable('synthetic_data_runs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  taskKind:       text('task_kind').notNull(),
  seedExamples:   jsonb('seed_examples').$type<Array<Record<string, unknown>>>().notNull().default([]),
  generatedCount: integer('generated_count').notNull().default(0),
  outputPath:     text('output_path'),
  status:         text('status').notNull().default('pending'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('sdr_ws_idx').on(t.workspaceId, t.createdAt)])

// ─── R146.142 — AI C-tier ──────────────────────────────────────────────

export const finetuneJobs = pgTable('finetune_jobs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  provider:       text('provider').notNull(),
  baseModel:      text('base_model').notNull(),
  datasetPath:    text('dataset_path').notNull(),
  externalJobId:  text('external_job_id'),
  status:         text('status').notNull().default('submitted'),
  tunedModelId:   text('tuned_model_id'),
  costUsd:        real('cost_usd'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('fj_ws_idx').on(t.workspaceId, t.createdAt)])

export const batchJobs = pgTable('batch_jobs', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  provider:         text('provider').notNull(),
  externalBatchId:  text('external_batch_id'),
  requestCount:     integer('request_count').notNull().default(0),
  completedCount:   integer('completed_count').notNull().default(0),
  status:           text('status').notNull().default('submitted'),
  costUsd:          real('cost_usd'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('bj_ws_idx').on(t.workspaceId, t.createdAt)])

// ─── R146.143 — S-tier AI 21-25 ────────────────────────────────────────

export const workflows = pgTable('workflows', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name:        text('name').notNull(),
  steps:       jsonb('steps').$type<Array<{ name: string; opName: string; params: Record<string, unknown>; retryOn?: string }>>().notNull().default([]),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('wf_ws_idx').on(t.workspaceId, t.createdAt)])

export const agentWorkflowRuns = pgTable('agent_workflow_runs', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  workflowId:  text('workflow_id').notNull(),
  currentStep: integer('current_step').notNull().default(0),
  stepOutputs: jsonb('step_outputs').$type<Array<{ stepName: string; ok: boolean; result?: unknown; error?: string }>>().notNull().default([]),
  status:      text('status').notNull().default('running'),
  error:       text('error'),
  startedAt:   bigint('started_at', { mode: 'number' }).notNull(),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('awfr_ws_idx').on(t.workspaceId, t.startedAt),
  index('awfr_status_idx').on(t.workspaceId, t.status),
])

export const finetuneCycles = pgTable('finetune_cycles', {
  id:                 text('id').primaryKey(),
  workspaceId:        text('workspace_id').notNull(),
  baseModel:          text('base_model').notNull(),
  distillDatasetId:   text('distill_dataset_id'),
  finetuneJobId:      text('finetune_job_id'),
  abTrialId:          text('ab_trial_id'),
  promoted:           boolean('promoted').notNull().default(false),
  status:             text('status').notNull().default('queued'),
  createdAt:          bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:          bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('ftc_ws_idx').on(t.workspaceId, t.createdAt)])

export const voiceChatSessions = pgTable('voice_chat_sessions', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  transcript:  text('transcript').notNull().default(''),
  audioPath:   text('audio_path'),
  status:      text('status').notNull().default('open'),
  startedAt:   bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:     bigint('ended_at',   { mode: 'number' }),
}, (t) => [index('vcs_ws_idx').on(t.workspaceId, t.startedAt)])

export const mcpClients = pgTable('mcp_clients', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name:        text('name').notNull(),
  apiKeyHash:  text('api_key_hash').notNull(),
  allowedOps:  jsonb('allowed_ops').$type<string[]>().notNull().default([]),
  lastUsedAt:  bigint('last_used_at', { mode: 'number' }),
  createdAt:   bigint('created_at',   { mode: 'number' }).notNull(),
}, (t) => [index('mcp_ws_idx').on(t.workspaceId)])

// ─── R146.145 — B2-tier AI ─────────────────────────────────────────────

export const embeddingCache = pgTable('embedding_cache', {
  textHash:   text('text_hash').primaryKey(),
  provider:   text('provider').notNull(),
  embedding:  vector('embedding', { dimensions: 768 }).notNull(),
  createdAt:  bigint('created_at', { mode: 'number' }).notNull(),
  hitCount:   integer('hit_count').notNull().default(0),
})

export const opModelPins = pgTable('op_model_pins', {
  workspaceId: text('workspace_id').notNull(),
  opName:      text('op_name').notNull(),
  provider:    text('provider').notNull(),
  model:       text('model').notNull(),
  pinnedAt:    bigint('pinned_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.opName] })])

export const adaptiveTemperatures = pgTable('adaptive_temperatures', {
  workspaceId:  text('workspace_id').notNull(),
  taskType:     text('task_type').notNull(),
  temperature:  real('temperature').notNull().default(0.7),
  samples:      integer('samples').notNull().default(0),
  avgScore:     real('avg_score').notNull().default(0),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.taskType] })])

// ─── R146.147 — Second-brain S-tier ────────────────────────────────────

export const memoryLinks = pgTable('memory_links', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  srcChunkId:   text('src_chunk_id').notNull(),
  dstChunkId:   text('dst_chunk_id').notNull(),
  linkType:     text('link_type').notNull().default('wiki'),
  context:      text('context'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ml_src_idx').on(t.workspaceId, t.srcChunkId),
  index('ml_dst_idx').on(t.workspaceId, t.dstChunkId),
  index('ml_type_idx').on(t.workspaceId, t.linkType),
])

export const dailyNotes = pgTable('daily_notes', {
  workspaceId: text('workspace_id').notNull(),
  date:        text('date').notNull(),
  chunkId:     text('chunk_id').notNull(),
  prevDate:    text('prev_date'),
  nextDate:    text('next_date'),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.date] })])

export const memoryTags = pgTable('memory_tags', {
  workspaceId: text('workspace_id').notNull(),
  chunkId:     text('chunk_id').notNull(),
  tag:         text('tag').notNull(),
  source:      text('source').notNull().default('auto'),
  confidence:  real('confidence').notNull().default(1.0),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.chunkId, t.tag] }),
  index('mt_tag_idx').on(t.workspaceId, t.tag),
])

export const memoryOutline = pgTable('memory_outline', {
  workspaceId:    text('workspace_id').notNull(),
  chunkId:        text('chunk_id').notNull(),
  parentChunkId:  text('parent_chunk_id'),
  sortOrder:      integer('sort_order').notNull().default(0),
  collapsed:      boolean('collapsed').notNull().default(false),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.chunkId] }),
  index('mo_parent_idx').on(t.workspaceId, t.parentChunkId, t.sortOrder),
])

export const inboxItems = pgTable('inbox_items', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  kind:                text('kind').notNull(),
  rawContent:          text('raw_content').notNull(),
  sourceUrl:           text('source_url'),
  processed:           boolean('processed').notNull().default(false),
  processedChunkId:    text('processed_chunk_id'),
  extracted:           jsonb('extracted').$type<Record<string, unknown>>().notNull().default({}),
  capturedAt:          bigint('captured_at',  { mode: 'number' }).notNull(),
  processedAt:         bigint('processed_at', { mode: 'number' }),
}, (t) => [
  index('ii_ws_idx').on(t.workspaceId, t.capturedAt),
])

// ─── R146.148 — Second-brain A-tier ────────────────────────────────────

export const srsCards = pgTable('srs_cards', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  chunkId:      text('chunk_id').notNull(),
  front:        text('front').notNull(),
  back:         text('back').notNull(),
  intervalDays: integer('interval_days').notNull().default(1),
  ease:         real('ease').notNull().default(2.5),
  reps:         integer('reps').notNull().default(0),
  nextReviewAt: bigint('next_review_at', { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('srs_due_idx').on(t.workspaceId, t.nextReviewAt)])

export const people = pgTable('people', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  name:         text('name').notNull(),
  email:        text('email'),
  org:          text('org'),
  notes:        text('notes'),
  lastContactAt: bigint('last_contact_at', { mode: 'number' }),
  followUpAt:   bigint('follow_up_at',   { mode: 'number' }),
  metadata:     jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('people_ws_idx').on(t.workspaceId, t.name),
  index('people_follow_idx').on(t.workspaceId, t.followUpAt),
])

export const personInteractions = pgTable('person_interactions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  personId:     text('person_id').notNull(),
  channel:      text('channel').notNull(),
  notes:        text('notes').notNull(),
  occurredAt:   bigint('occurred_at', { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at',  { mode: 'number' }).notNull(),
}, (t) => [index('pi_person_idx').on(t.personId, t.occurredAt)])

export const readingQueue = pgTable('reading_queue', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  title:        text('title').notNull(),
  url:          text('url'),
  estimatedMin: integer('estimated_min'),
  status:       text('status').notNull().default('queued'),
  notesChunkId: text('notes_chunk_id'),
  addedAt:      bigint('added_at',    { mode: 'number' }).notNull(),
  startedAt:    bigint('started_at',  { mode: 'number' }),
  finishedAt:   bigint('finished_at', { mode: 'number' }),
}, (t) => [index('rq_ws_status_idx').on(t.workspaceId, t.status, t.addedAt)])

export const weeklyReviews = pgTable('weekly_reviews', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  weekStarting:  text('week_starting').notNull(),
  synthesis:     text('synthesis').notNull(),
  chunkId:       text('chunk_id'),
  metrics:       jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
  generatedAt:   bigint('generated_at', { mode: 'number' }).notNull(),
})

// ─── R146.149 — SB B-tier ─────────────────────────────────────────────

export const decisions = pgTable('decisions', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  question:         text('question').notNull(),
  reasoning:        text('reasoning').notNull(),
  expectedOutcome:  text('expected_outcome'),
  alternatives:     jsonb('alternatives').$type<string[]>().notNull().default([]),
  confidence:       real('confidence').notNull().default(0.5),
  reviewAt:         bigint('review_at',  { mode: 'number' }).notNull(),
  actualOutcome:    text('actual_outcome'),
  calibrationScore: real('calibration_score'),
  decidedAt:        bigint('decided_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('dec_ws_idx').on(t.workspaceId, t.decidedAt),
  index('dec_review_idx').on(t.workspaceId, t.reviewAt),
])

export const ideasIncubator = pgTable('ideas', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  title:            text('title').notNull(),
  body:             text('body').notNull(),
  status:           text('status').notNull().default('incubating'),
  mentionCount:     integer('mention_count').notNull().default(0),
  lastMentionedAt:  bigint('last_mentioned_at', { mode: 'number' }),
  createdAt:        bigint('created_at',        { mode: 'number' }).notNull(),
}, (t) => [index('ii_ws_status_idx').on(t.workspaceId, t.status, t.createdAt)])

export const qaPairs = pgTable('qa_pairs', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  question:         text('question').notNull(),
  answer:           text('answer').notNull(),
  conversationId:   text('conversation_id'),
  chunkId:          text('chunk_id'),
  reuseCount:       integer('reuse_count').notNull().default(0),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('qa_ws_idx').on(t.workspaceId, t.createdAt)])

export const conceptMaturity = pgTable('concept_maturity', {
  workspaceId:      text('workspace_id').notNull(),
  concept:          text('concept').notNull(),
  referenceCount:   integer('reference_count').notNull().default(0),
  firstSeenAt:      bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:       bigint('last_seen_at',  { mode: 'number' }).notNull(),
  maturity:         text('maturity').notNull().default('fresh'),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.concept] }),
  index('cm_maturity_idx').on(t.workspaceId, t.maturity, t.lastSeenAt),
])

// ─── R146.150 — SB C-tier ─────────────────────────────────────────────

export const memorySnapshots = pgTable('memory_snapshots', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  snapshotDate:  text('snapshot_date').notNull(),
  chunkCount:    integer('chunk_count').notNull().default(0),
  linkCount:     integer('link_count').notNull().default(0),
  tagCount:      integer('tag_count').notNull().default(0),
  manifest:      jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
})

export const voiceJournals = pgTable('voice_journals', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  date:         text('date').notNull(),
  audioPath:    text('audio_path'),
  transcript:   text('transcript'),
  chunkId:      text('chunk_id'),
  durationSec:  integer('duration_sec'),
  status:       text('status').notNull().default('recorded'),
  recordedAt:   bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [index('vj_ws_date_idx').on(t.workspaceId, t.date)])

export const externalImports = pgTable('external_imports', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  source:         text('source').notNull(),
  sourceRef:      text('source_ref'),
  importedCount:  integer('imported_count').notNull().default(0),
  status:         text('status').notNull().default('pending'),
  metadata:       jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  importedAt:     bigint('imported_at', { mode: 'number' }).notNull(),
}, (t) => [index('ei_ws_idx').on(t.workspaceId, t.importedAt)])

// ─── R146.151 — SB2 S-tier ─────────────────────────────────────────────

export const habits = pgTable('habits', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  name:           text('name').notNull(),
  cadence:        text('cadence').notNull().default('daily'),
  active:         boolean('active').notNull().default(true),
  currentStreak:  integer('current_streak').notNull().default(0),
  longestStreak:  integer('longest_streak').notNull().default(0),
  lastDoneDate:   text('last_done_date'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('habits_ws_idx').on(t.workspaceId, t.active)])

export const habitLogs = pgTable('habit_logs', {
  workspaceId: text('workspace_id').notNull(),
  habitId:     text('habit_id').notNull(),
  date:        text('date').notNull(),
  done:        boolean('done').notNull().default(true),
  notes:       text('notes'),
  loggedAt:    bigint('logged_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.habitId, t.date] })])

export const objectives = pgTable('objectives', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  title:        text('title').notNull(),
  quarter:      text('quarter').notNull(),
  status:       text('status').notNull().default('active'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('obj_ws_idx').on(t.workspaceId, t.quarter, t.status)])

export const keyResults = pgTable('key_results', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  objectiveId:   text('objective_id').notNull(),
  title:         text('title').notNull(),
  targetValue:   real('target_value'),
  currentValue:  real('current_value').notNull().default(0),
  unit:          text('unit'),
  confidence:    real('confidence').notNull().default(0.5),
  updatedAt:     bigint('updated_at', { mode: 'number' }).notNull(),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('kr_obj_idx').on(t.objectiveId)])

export const focusSessions = pgTable('focus_sessions', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  description:   text('description').notNull(),
  durationMin:   integer('duration_min').notNull(),
  outputChunkId: text('output_chunk_id'),
  tags:          jsonb('tags').$type<string[]>().notNull().default([]),
  startedAt:     bigint('started_at',  { mode: 'number' }).notNull(),
  finishedAt:    bigint('finished_at', { mode: 'number' }),
}, (t) => [index('fs_ws_idx').on(t.workspaceId, t.startedAt)])

export const moodLogs = pgTable('mood_logs', {
  workspaceId: text('workspace_id').notNull(),
  date:        text('date').notNull(),
  slot:        text('slot').notNull(),
  mood:        integer('mood').notNull(),
  energy:      integer('energy').notNull(),
  notes:       text('notes'),
  loggedAt:    bigint('logged_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.date, t.slot] })])

export const noteTemplates = pgTable('note_templates', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name:        text('name').notNull(),
  body:        text('body').notNull(),
  variables:   jsonb('variables').$type<string[]>().notNull().default([]),
  createdAt:   bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('nt_ws_idx').on(t.workspaceId, t.name)])

// ─── R146.152 — SB2 A-tier ─────────────────────────────────────────────

export const digestSubscriptions = pgTable('digest_subscriptions', {
  workspaceId: text('workspace_id').primaryKey(),
  email:       text('email').notNull(),
  cadence:     text('cadence').notNull().default('weekly'),
  lastSentAt:  bigint('last_sent_at', { mode: 'number' }),
  active:      boolean('active').notNull().default(true),
  updatedAt:   bigint('updated_at', { mode: 'number' }).notNull(),
})

export const chunkAnnotations = pgTable('chunk_annotations', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  chunkId:      text('chunk_id').notNull(),
  body:         text('body').notNull(),
  color:        text('color').notNull().default('yellow'),
  startOffset:  integer('start_offset'),
  endOffset:    integer('end_offset'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('ca_chunk_idx').on(t.chunkId)])

export const chunkRevisions = pgTable('chunk_revisions', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  chunkId:      text('chunk_id').notNull(),
  prevContent:  text('prev_content').notNull(),
  diffSummary:  text('diff_summary'),
  editedBy:     text('edited_by').notNull().default('operator'),
  editedAt:     bigint('edited_at', { mode: 'number' }).notNull(),
}, (t) => [index('cr_chunk_idx').on(t.workspaceId, t.chunkId, t.editedAt)])

export const chunkConfidence = pgTable('chunk_confidence', {
  workspaceId:    text('workspace_id').notNull(),
  chunkId:        text('chunk_id').notNull(),
  confidence:     real('confidence').notNull().default(0.7),
  sources:        jsonb('sources').$type<string[]>().notNull().default([]),
  contradictions: jsonb('contradictions').$type<Array<{ chunkId: string; reason: string }>>().notNull().default([]),
  updatedAt:      bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.chunkId] })])

// ─── R146.155 — SB3 S-tier ─────────────────────────────────────────────

export const questionsBacklog = pgTable('questions_backlog', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  question:        text('question').notNull(),
  contextChunkId:  text('context_chunk_id'),
  status:          text('status').notNull().default('open'),
  answerChunkId:   text('answer_chunk_id'),
  raisedAt:        bigint('raised_at',   { mode: 'number' }).notNull(),
  answeredAt:      bigint('answered_at', { mode: 'number' }),
  priority:        integer('priority').notNull().default(0),
}, (t) => [index('qb_ws_status_idx').on(t.workspaceId, t.status, t.raisedAt)])

// ─── R146.158 — SB3 C-tier ─────────────────────────────────────────────

export const dreamEntries = pgTable('dream_entries', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  date:        text('date').notNull(),
  body:        text('body').notNull(),
  themes:      jsonb('themes').$type<string[]>().notNull().default([]),
  vivid:       boolean('vivid').notNull().default(false),
  chunkId:     text('chunk_id'),
  recordedAt:  bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [index('de_ws_date_idx').on(t.workspaceId, t.date)])

export const bodyMetrics = pgTable('body_metrics', {
  workspaceId: text('workspace_id').notNull(),
  date:        text('date').notNull(),
  metric:      text('metric').notNull(),
  value:       real('value').notNull(),
  source:      text('source').notNull().default('manual'),
  recordedAt:  bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.date, t.metric] })])

export const publicPublishes = pgTable('public_publishes', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  slug:           text('slug').notNull().unique(),
  chunkId:        text('chunk_id').notNull(),
  title:          text('title').notNull(),
  body:           text('body').notNull(),
  viewCount:      integer('view_count').notNull().default(0),
  publishedAt:    bigint('published_at',   { mode: 'number' }).notNull(),
  unpublishedAt:  bigint('unpublished_at', { mode: 'number' }),
}, (t) => [index('pp_ws_idx').on(t.workspaceId, t.publishedAt)])

export const inheritanceManifests = pgTable('inheritance_manifests', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  recipientHint:  text('recipient_hint').notNull(),
  bodyMd:         text('body_md').notNull(),
  manifestData:   jsonb('manifest_data').$type<Record<string, unknown>>().notNull().default({}),
  generatedAt:    bigint('generated_at', { mode: 'number' }).notNull(),
}, (t) => [index('im_ws_idx').on(t.workspaceId, t.generatedAt)])

// ─── R146.160 — PAI 7-phase loop for video gen ─────────────────────
export const videoIsa = pgTable('video_isa', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  title:        text('title').notNull(),
  brief:        text('brief').notNull(),
  telos:        jsonb('telos').$type<Record<string, unknown>>().notNull().default({}),
  iscs:         jsonb('iscs').$type<Array<{ id: string; criterion: string; weight: number; kind: string }>>().notNull().default([]),
  target:       jsonb('target').$type<Record<string, unknown>>().notNull().default({}),
  status:       text('status').notNull().default('active'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  archivedAt:   bigint('archived_at', { mode: 'number' }),
}, (t) => [index('vi_ws_idx').on(t.workspaceId, t.status, t.createdAt)])

export const videoPaiRun = pgTable('video_pai_run', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  isaId:        text('isa_id').notNull(),
  episodeId:    text('episode_id'),
  phase:        text('phase').notNull().default('observe'),
  observe:      jsonb('observe').$type<Record<string, unknown>>().notNull().default({}),
  think:        jsonb('think').$type<Record<string, unknown>>().notNull().default({}),
  plan:         jsonb('plan').$type<Record<string, unknown>>().notNull().default({}),
  build:        jsonb('build').$type<Record<string, unknown>>().notNull().default({}),
  execute:      jsonb('execute').$type<Record<string, unknown>>().notNull().default({}),
  verify:       jsonb('verify').$type<Record<string, unknown>>().notNull().default({}),
  learn:        jsonb('learn').$type<Record<string, unknown>>().notNull().default({}),
  iscPassRate:  real('isc_pass_rate').notNull().default(0),
  outcomeScore: real('outcome_score'),
  outcomeMeta:  jsonb('outcome_meta').$type<Record<string, unknown>>().notNull().default({}),
  costUsd:      real('cost_usd').notNull().default(0),
  startedAt:    bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:      bigint('ended_at', { mode: 'number' }),
  error:        text('error'),
}, (t) => [
  index('vpr_ws_idx').on(t.workspaceId, t.startedAt),
  index('vpr_isa_idx').on(t.isaId, t.startedAt),
])

export const videoPaiLesson = pgTable('video_pai_lesson', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  topic:        text('topic').notNull(),
  pattern:      text('pattern').notNull(),
  evidence:     jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  confidence:   real('confidence').notNull().default(0.5),
  uses:         integer('uses').notNull().default(0),
  wins:         integer('wins').notNull().default(0),
  losses:       integer('losses').notNull().default(0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  retiredAt:    bigint('retired_at', { mode: 'number' }),
}, (t) => [index('vpl_ws_idx').on(t.workspaceId, t.topic, t.confidence)])

// ─── R146.161 — Social comment harvest + self-improvement ──────────
export const socialComment = pgTable('social_comment', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  platform:        text('platform').notNull(),
  accountId:       text('account_id').notNull(),
  postId:          text('post_id'),
  externalPostId:  text('external_post_id'),
  externalId:      text('external_id').notNull(),
  authorHandle:    text('author_handle'),
  authorId:        text('author_id'),
  body:            text('body').notNull(),
  publishedAt:     bigint('published_at', { mode: 'number' }),
  fetchedAt:       bigint('fetched_at', { mode: 'number' }).notNull(),
  sentiment:       text('sentiment'),
  intent:          text('intent'),
  themes:          jsonb('themes').$type<string[]>().notNull().default([]),
  replyPriority:   integer('reply_priority').notNull().default(0),
  hiddenAt:        bigint('hidden_at', { mode: 'number' }),
  repliedAt:       bigint('replied_at', { mode: 'number' }),
  replyExternalId: text('reply_external_id'),
}, (t) => [
  uniqueIndex('sc_platform_extid_idx').on(t.platform, t.externalId),
  index('sc_ws_idx').on(t.workspaceId, t.fetchedAt),
  index('sc_ws_intent_idx').on(t.workspaceId, t.intent, t.fetchedAt),
])

export const socialCommentTheme = pgTable('social_comment_theme', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  theme:         text('theme').notNull(),
  count:         integer('count').notNull().default(0),
  posCount:      integer('pos_count').notNull().default(0),
  negCount:      integer('neg_count').notNull().default(0),
  sentimentAvg:  real('sentiment_avg').notNull().default(0),
  firstSeenAt:   bigint('first_seen_at', { mode: 'number' }).notNull(),
  lastSeenAt:    bigint('last_seen_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('sct_ws_theme_idx').on(t.workspaceId, t.theme),
  index('sct_ws_count_idx').on(t.workspaceId, t.count),
])

export const socialReplyDraft = pgTable('social_reply_draft', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  commentId:    text('comment_id').notNull(),
  body:         text('body').notNull(),
  source:       text('source').notNull().default('rules'),
  model:        text('model'),
  status:       text('status').notNull().default('draft'),
  approvedBy:   text('approved_by'),
  approvedAt:   bigint('approved_at', { mode: 'number' }),
  sentAt:       bigint('sent_at', { mode: 'number' }),
  sendError:    text('send_error'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('srd_ws_idx').on(t.workspaceId, t.status, t.createdAt),
  index('srd_comment_idx').on(t.commentId),
])

// ─── R146.162 — Owned-audience loop ────────────────────────────────
export const leadMagnet = pgTable('lead_magnet', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  title:        text('title').notNull(),
  slug:         text('slug').notNull(),
  format:       text('format').notNull().default('pdf'),
  body:         text('body').notNull(),
  fileUrl:      text('file_url'),
  signups:      integer('signups').notNull().default(0),
  status:       text('status').notNull().default('active'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  archivedAt:   bigint('archived_at', { mode: 'number' }),
}, (t) => [
  uniqueIndex('lm_ws_slug_idx').on(t.workspaceId, t.slug),
  index('lm_ws_idx').on(t.workspaceId, t.status, t.createdAt),
])

export const leadCapture = pgTable('lead_capture', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  magnetId:        text('magnet_id'),
  email:           text('email').notNull(),
  name:            text('name'),
  source:          text('source').notNull().default('page'),
  sourceRef:       text('source_ref'),
  segments:        jsonb('segments').$type<string[]>().notNull().default([]),
  subscribedAt:    bigint('subscribed_at', { mode: 'number' }).notNull(),
  unsubscribedAt:  bigint('unsubscribed_at', { mode: 'number' }),
  lastOpenAt:      bigint('last_open_at', { mode: 'number' }),
  lastClickAt:     bigint('last_click_at', { mode: 'number' }),
  bounceCount:     integer('bounce_count').notNull().default(0),
}, (t) => [
  uniqueIndex('lc_ws_email_idx').on(t.workspaceId, t.email),
  index('lc_ws_subscribed_idx').on(t.workspaceId, t.subscribedAt),
])

export const emailCampaign = pgTable('email_campaign', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  name:           text('name').notNull(),
  subjectA:       text('subject_a').notNull(),
  subjectB:       text('subject_b'),
  body:           text('body').notNull(),
  segmentFilter:  jsonb('segment_filter').$type<Record<string, unknown>>().notNull().default({}),
  fromAddress:    text('from_address'),
  fromName:       text('from_name'),
  replyTo:        text('reply_to'),
  scheduledAt:    bigint('scheduled_at', { mode: 'number' }),
  sentAt:         bigint('sent_at', { mode: 'number' }),
  status:         text('status').notNull().default('draft'),
  sends:          integer('sends').notNull().default(0),
  opens:          integer('opens').notNull().default(0),
  clicks:         integer('clicks').notNull().default(0),
  bounces:        integer('bounces').notNull().default(0),
  winnerVariant:  text('winner_variant'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ec_ws_idx').on(t.workspaceId, t.status, t.createdAt),
  index('ec_scheduled_idx').on(t.status, t.scheduledAt),
])

export const emailSend = pgTable('email_send', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  campaignId:   text('campaign_id').notNull(),
  captureId:    text('capture_id').notNull(),
  variant:      text('variant').notNull().default('a'),
  provider:     text('provider').notNull().default('resend'),
  providerId:   text('provider_id'),
  sentAt:       bigint('sent_at', { mode: 'number' }).notNull(),
  openedAt:     bigint('opened_at', { mode: 'number' }),
  clickedAt:    bigint('clicked_at', { mode: 'number' }),
  bouncedAt:    bigint('bounced_at', { mode: 'number' }),
  error:        text('error'),
}, (t) => [
  index('es_campaign_idx').on(t.campaignId, t.sentAt),
  index('es_capture_idx').on(t.captureId, t.sentAt),
])

// ─── R146.163 — Volume engines ─────────────────────────────────────
export const repurposePack = pgTable('repurpose_pack', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  sourceKind:   text('source_kind').notNull().default('text'),
  sourceRef:    text('source_ref'),
  sourceBody:   text('source_body').notNull(),
  title:        text('title'),
  variantCount: integer('variant_count').notNull().default(0),
  status:       text('status').notNull().default('ready'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('rp_ws_idx').on(t.workspaceId, t.createdAt)])

export const repurposeVariant = pgTable('repurpose_variant', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  packId:              text('pack_id').notNull(),
  format:              text('format').notNull(),
  body:                text('body').notNull(),
  score:               real('score'),
  usedAt:              bigint('used_at', { mode: 'number' }),
  publishedExternalId: text('published_external_id'),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rv_pack_idx').on(t.packId),
  index('rv_ws_format_idx').on(t.workspaceId, t.format, t.createdAt),
])

export const competitorHandle = pgTable('competitor_handle', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  businessId:    text('business_id'),
  platform:      text('platform').notNull(),
  handle:        text('handle').notNull(),
  niche:         text('niche'),
  notes:         text('notes'),
  status:        text('status').notNull().default('active'),
  addedAt:       bigint('added_at', { mode: 'number' }).notNull(),
  lastScannedAt: bigint('last_scanned_at', { mode: 'number' }),
}, (t) => [
  uniqueIndex('ch_ws_platform_handle_idx').on(t.workspaceId, t.platform, t.handle),
  index('ch_ws_idx').on(t.workspaceId, t.status),
])

export const competitorWinner = pgTable('competitor_winner', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  competitorId:  text('competitor_id').notNull(),
  externalId:    text('external_id'),
  body:          text('body').notNull(),
  metricScore:   real('metric_score'),
  theme:         text('theme'),
  recordedAt:    bigint('recorded_at', { mode: 'number' }).notNull(),
  source:        text('source').notNull().default('agent'),
}, (t) => [
  index('cw_ws_idx').on(t.workspaceId, t.recordedAt),
  index('cw_comp_idx').on(t.competitorId, t.recordedAt),
  index('cw_theme_idx').on(t.workspaceId, t.theme),
])

// ─── R146.164 — Funnel CRO ─────────────────────────────────────────
export const funnelEvent = pgTable('funnel_event', {
  id:          text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  businessId:  text('business_id'),
  sessionId:   text('session_id').notNull(),
  kind:        text('kind').notNull(),
  source:      text('source'),
  medium:      text('medium'),
  campaign:    text('campaign'),
  page:        text('page'),
  ref:         text('ref'),
  amountCents: integer('amount_cents'),
  meta:        jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
  captureId:   text('capture_id'),
  at:          bigint('at', { mode: 'number' }).notNull(),
}, (t) => [
  index('fe_ws_idx').on(t.workspaceId, t.at),
  index('fe_session_idx').on(t.sessionId, t.at),
  index('fe_kind_idx').on(t.workspaceId, t.kind, t.at),
])

export const funnelSession = pgTable('funnel_session', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  businessId:     text('business_id'),
  firstTouchAt:   bigint('first_touch_at', { mode: 'number' }).notNull(),
  lastTouchAt:    bigint('last_touch_at', { mode: 'number' }).notNull(),
  firstSource:    text('first_source'),
  firstCampaign:  text('first_campaign'),
  captureId:      text('capture_id'),
  purchased:      boolean('purchased').notNull().default(false),
  revenueCents:   integer('revenue_cents').notNull().default(0),
  viewCount:      integer('view_count').notNull().default(0),
  clickCount:     integer('click_count').notNull().default(0),
}, (t) => [
  index('fs_ws_idx').on(t.workspaceId, t.lastTouchAt),
  index('fs_purchased_idx').on(t.workspaceId, t.purchased, t.lastTouchAt),
])

export const banditExperiment = pgTable('bandit_experiment', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  name:         text('name').notNull(),
  variants:     jsonb('variants').$type<Array<{ id: string; label: string; alpha: number; beta: number; impressions: number; conversions: number }>>().notNull().default([]),
  status:       text('status').notNull().default('running'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  concludedAt:  bigint('concluded_at', { mode: 'number' }),
  winner:       text('winner'),
}, (t) => [
  uniqueIndex('be_ws_name_idx').on(t.workspaceId, t.name),
  index('be_ws_status_idx').on(t.workspaceId, t.status),
])

export const cartAbandonment = pgTable('cart_abandonment', {
  id:                   text('id').primaryKey(),
  workspaceId:          text('workspace_id').notNull(),
  businessId:           text('business_id'),
  sessionId:            text('session_id'),
  email:                text('email'),
  cartValueCents:       integer('cart_value_cents').notNull().default(0),
  items:                jsonb('items').$type<Array<Record<string, unknown>>>().notNull().default([]),
  abandonedAt:          bigint('abandoned_at', { mode: 'number' }).notNull(),
  recoveredAt:          bigint('recovered_at', { mode: 'number' }),
  recoveryCampaignId:   text('recovery_campaign_id'),
  recoveryStatus:       text('recovery_status').notNull().default('pending'),
}, (t) => [
  index('ca_ws_idx').on(t.workspaceId, t.abandonedAt),
  index('ca_status_idx').on(t.workspaceId, t.recoveryStatus, t.abandonedAt),
])

// ─── R146.165 — Revenue intelligence ───────────────────────────────
export const seoArticle = pgTable('seo_article', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  query:        text('query').notNull(),
  title:        text('title').notNull(),
  slug:         text('slug').notNull(),
  body:         text('body').notNull(),
  metaDesc:     text('meta_desc'),
  intent:       text('intent').notNull().default('commercial'),
  status:       text('status').notNull().default('draft'),
  views:        integer('views').notNull().default(0),
  clicks:       integer('clicks').notNull().default(0),
  conversions:  integer('conversions').notNull().default(0),
  publishedAt:  bigint('published_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('sa_ws_slug_idx').on(t.workspaceId, t.slug),
  index('sa_ws_idx').on(t.workspaceId, t.status, t.publishedAt),
])

export const customerScore = pgTable('customer_score', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  businessId:          text('business_id'),
  customerRef:         text('customer_ref').notNull(),
  revenueCents:        integer('revenue_cents').notNull().default(0),
  predictedLtvCents:   integer('predicted_ltv_cents').notNull().default(0),
  decile:              integer('decile').notNull().default(5),
  signals:             jsonb('signals').$type<Record<string, unknown>>().notNull().default({}),
  lastPurchaseAt:      bigint('last_purchase_at', { mode: 'number' }),
  firstSeenAt:         bigint('first_seen_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('cs_ws_ref_idx').on(t.workspaceId, t.customerRef),
  index('cs_ws_decile_idx').on(t.workspaceId, t.decile),
])

export const crossBusinessOverlap = pgTable('cross_business_overlap', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  businessA:        text('business_a').notNull(),
  businessB:        text('business_b').notNull(),
  sharedCustomers:  integer('shared_customers').notNull().default(0),
  totalA:           integer('total_a').notNull().default(0),
  totalB:           integer('total_b').notNull().default(0),
  overlapPct:       real('overlap_pct').notNull().default(0),
  computedAt:       bigint('computed_at', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('cbo_ws_pair_idx').on(t.workspaceId, t.businessA, t.businessB)])

export const refundReason = pgTable('refund_reason', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  orderRef:     text('order_ref'),
  customerRef:  text('customer_ref'),
  reasonText:   text('reason_text').notNull(),
  category:     text('category'),
  amountCents:  integer('amount_cents').notNull().default(0),
  recordedAt:   bigint('recorded_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('rr_ws_idx').on(t.workspaceId, t.recordedAt),
  index('rr_ws_cat_idx').on(t.workspaceId, t.category),
])

// ─── R146.166 — Director controls (Higgsfield-inspired) ────────────
export const directorProfile = pgTable('director_profile', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  businessId:   text('business_id'),
  name:         text('name').notNull(),
  cameraBody:   text('camera_body').notNull().default('arri_alexa_35'),
  lens:         text('lens').notNull().default('zeiss_supreme_50'),
  focalMm:      integer('focal_mm').notNull().default(50),
  aperture:     real('aperture').notNull().default(2.8),
  shutterDeg:   integer('shutter_deg').notNull().default(180),
  motions:      jsonb('motions').$type<string[]>().notNull().default([]),
  colorGrade:   text('color_grade').notNull().default('natural'),
  vibe:         text('vibe'),
  notes:        text('notes'),
  status:       text('status').notNull().default('active'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('dp_ws_name_idx').on(t.workspaceId, t.name),
  index('dp_ws_idx').on(t.workspaceId, t.status, t.createdAt),
])

export const characterLock = pgTable('character_lock', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  businessId:      text('business_id'),
  name:            text('name').notNull(),
  description:     text('description').notNull(),
  referenceUrls:   jsonb('reference_urls').$type<string[]>().notNull().default([]),
  appearanceSeed:  integer('appearance_seed'),
  voiceId:         text('voice_id'),
  status:          text('status').notNull().default('active'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('cl_ws_name_idx').on(t.workspaceId, t.name),
  index('cl_ws_idx').on(t.workspaceId, t.status),
])

export const directorRunBinding = pgTable('director_run_binding', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  runId:         text('run_id').notNull(),
  profileId:     text('profile_id').notNull(),
  characterIds:  jsonb('character_ids').$type<string[]>().notNull().default([]),
  boundAt:       bigint('bound_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('drb_run_idx').on(t.runId),
  index('drb_ws_idx').on(t.workspaceId, t.boundAt),
])

// ─── R146.167 — Auto-publish pipeline ──────────────────────────────
export const publishPlan = pgTable('publish_plan', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  businessId:       text('business_id'),
  runId:            text('run_id').notNull(),
  sourceKind:       text('source_kind').notNull().default('pai_run'),
  platforms:        jsonb('platforms').$type<string[]>().notNull().default([]),
  assetPaths:       jsonb('asset_paths').$type<string[]>().notNull().default([]),
  socialPostIds:    jsonb('social_post_ids').$type<string[]>().notNull().default([]),
  repurposePackId:  text('repurpose_pack_id'),
  scheduledAt:      bigint('scheduled_at', { mode: 'number' }),
  status:           text('status').notNull().default('draft'),
  error:            text('error'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('pp_run_idx').on(t.runId),
  index('pp_ws_idx').on(t.workspaceId, t.status, t.createdAt),
])

// ─── R146.171 — Audio sync ─────────────────────────────────────────
export const audioSyncJob = pgTable('audio_sync_job', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  runId:        text('run_id'),
  shotId:       text('shot_id'),
  kind:         text('kind').notNull(),
  inputVideo:   text('input_video'),
  inputAudio:   text('input_audio'),
  scriptText:   text('script_text'),
  sceneDesc:    text('scene_desc'),
  outputPath:   text('output_path'),
  provider:     text('provider'),
  costUsd:      real('cost_usd').notNull().default(0),
  status:       text('status').notNull().default('queued'),
  error:        text('error'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  endedAt:      bigint('ended_at', { mode: 'number' }),
}, (t) => [
  index('asj_ws_idx').on(t.workspaceId, t.createdAt),
  index('asj_run_idx').on(t.runId, t.createdAt),
  index('asj_status_idx').on(t.workspaceId, t.status),
])

// ─── R146.172 — Mixcraft adapter ───────────────────────────────────
export const mixcraftBundle = pgTable('mixcraft_bundle', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  businessId:       text('business_id'),
  sourceKind:       text('source_kind').notNull().default('music_job'),
  sourceRef:        text('source_ref'),
  name:             text('name').notNull(),
  bpm:              integer('bpm').notNull().default(120),
  timeSignature:    text('time_signature').notNull().default('4/4'),
  sampleRate:       integer('sample_rate').notNull().default(44100),
  bitDepth:         integer('bit_depth').notNull().default(24),
  masterAudioUrl:   text('master_audio_url'),
  durationSec:      real('duration_sec'),
  status:           text('status').notNull().default('ready'),
  importedAt:       bigint('imported_at', { mode: 'number' }),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('mb_ws_idx').on(t.workspaceId, t.status, t.createdAt)])

export const mixcraftTrack = pgTable('mixcraft_track', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  bundleId:     text('bundle_id').notNull(),
  name:         text('name').notNull(),
  role:         text('role').notNull().default('audio'),
  audioUrl:     text('audio_url').notNull(),
  midiUrl:      text('midi_url'),
  positionSec:  real('position_sec').notNull().default(0),
  durationSec:  real('duration_sec'),
  volumeDb:     real('volume_db').notNull().default(0),
  pan:          real('pan').notNull().default(0),
  muted:        boolean('muted').notNull().default(false),
  solo:         boolean('solo').notNull().default(false),
  colorHex:     text('color_hex'),
  orderIdx:     integer('order_idx').notNull().default(0),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('mt_bundle_idx').on(t.bundleId, t.orderIdx),
  index('mt_ws_idx').on(t.workspaceId),
])

// ─── R146.173 — Music deep analysis + reproduction + mastering ─────
export const songAnalysis = pgTable('song_analysis', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  sourceUrl:       text('source_url').notNull(),
  sourceKind:      text('source_kind').notNull().default('url'),
  title:           text('title'),
  artist:          text('artist'),
  durationSec:     real('duration_sec'),
  bpm:             real('bpm'),
  keySignature:    text('key_signature'),
  timeSignature:   text('time_signature').notNull().default('4/4'),
  mood:            text('mood'),
  energy:          real('energy'),
  loudnessLufs:    real('loudness_lufs'),
  truePeakDb:      real('true_peak_db'),
  sampleRate:      integer('sample_rate').notNull().default(44100),
  bitDepth:        integer('bit_depth').notNull().default(24),
  instruments:     jsonb('instruments').$type<Array<{ name: string; role?: string; prominence?: number; midiUrl?: string; stemUrl?: string }>>().notNull().default([]),
  structure:       jsonb('structure').$type<Array<{ section: string; startSec: number; durationSec: number; tags?: string[] }>>().notNull().default([]),
  stemsUrl:        jsonb('stems_url').$type<Record<string, string>>().notNull().default({}),
  analyzer:        text('analyzer'),
  status:          text('status').notNull().default('pending'),
  error:           text('error'),
  costUsd:         real('cost_usd').notNull().default(0),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  analyzedAt:      bigint('analyzed_at', { mode: 'number' }),
}, (t) => [
  index('sa_ws_idx').on(t.workspaceId, t.createdAt),
  index('sa_ws_status_idx').on(t.workspaceId, t.status),
])

export const musicRecipe = pgTable('music_recipe', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  businessId:          text('business_id'),
  sourceAnalysisId:    text('source_analysis_id'),
  name:                text('name').notNull(),
  prompt:              text('prompt').notNull(),
  bpm:                 real('bpm').notNull().default(120),
  keySignature:        text('key_signature'),
  timeSignature:       text('time_signature').notNull().default('4/4'),
  durationSec:         real('duration_sec').notNull().default(180),
  instruments:         jsonb('instruments').$type<Array<{ name: string; role?: string; soundDescriptor?: string; midiPatternHint?: string }>>().notNull().default([]),
  arrangement:         jsonb('arrangement').$type<Array<{ section: string; durationSec: number; dynamics?: string; notes?: string }>>().notNull().default([]),
  styleRefs:           jsonb('style_refs').$type<string[]>().notNull().default([]),
  targetLufs:          real('target_lufs').notNull().default(-14),
  status:              text('status').notNull().default('ready'),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('mr_ws_idx').on(t.workspaceId, t.createdAt)])

export const musicReproduction = pgTable('music_reproduction', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  recipeId:       text('recipe_id').notNull(),
  provider:       text('provider').notNull(),
  generationUrl:  text('generation_url'),
  stemsUrl:       jsonb('stems_url').$type<Record<string, string>>().notNull().default({}),
  masteredUrl:    text('mastered_url'),
  masterJobId:    text('master_job_id'),
  durationSec:    real('duration_sec'),
  costUsd:        real('cost_usd').notNull().default(0),
  status:         text('status').notNull().default('queued'),
  error:          text('error'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  endedAt:        bigint('ended_at', { mode: 'number' }),
}, (t) => [
  index('mp_ws_idx').on(t.workspaceId, t.createdAt),
  index('mp_recipe_idx').on(t.recipeId, t.createdAt),
])

export const masterJob = pgTable('master_job', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  inputUrl:         text('input_url').notNull(),
  referenceUrl:     text('reference_url'),
  outputUrl:        text('output_url'),
  lufsTarget:       real('lufs_target').notNull().default(-14),
  truePeakTarget:   real('true_peak_target').notNull().default(-1),
  provider:         text('provider').notNull().default('matchering'),
  costUsd:          real('cost_usd').notNull().default(0),
  status:           text('status').notNull().default('queued'),
  error:            text('error'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  endedAt:          bigint('ended_at', { mode: 'number' }),
}, (t) => [index('mj_ws_idx').on(t.workspaceId, t.createdAt)])

// ─── R146.174 — CapCut adapter ─────────────────────────────────────
export const capcutProject = pgTable('capcut_project', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  businessId:      text('business_id'),
  sourceKind:      text('source_kind').notNull().default('manual'),
  sourceRef:       text('source_ref'),
  name:            text('name').notNull(),
  width:           integer('width').notNull().default(1080),
  height:          integer('height').notNull().default(1920),
  fps:             integer('fps').notNull().default(30),
  durationMs:      integer('duration_ms').notNull().default(0),
  status:          text('status').notNull().default('ready'),
  masterAudioUrl:  text('master_audio_url'),
  coverUrl:        text('cover_url'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('cp_ws_idx').on(t.workspaceId, t.createdAt)])

export const capcutClip = pgTable('capcut_clip', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  projectId:        text('project_id').notNull(),
  kind:             text('kind').notNull(),
  assetUrl:         text('asset_url'),
  trackIdx:         integer('track_idx').notNull().default(0),
  startMs:          integer('start_ms').notNull().default(0),
  durationMs:       integer('duration_ms').notNull().default(0),
  sourceStartMs:    integer('source_start_ms').notNull().default(0),
  transform:        jsonb('transform').$type<Record<string, unknown>>().notNull().default({}),
  orderIdx:         integer('order_idx').notNull().default(0),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('cc_project_idx').on(t.projectId, t.trackIdx, t.startMs),
  index('cc_ws_idx').on(t.workspaceId),
])

// ─── R146.175 — Top-tier image generation + upscaling ──────────────
export const imageProJob = pgTable('image_pro_job', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  businessId:     text('business_id'),
  prompt:         text('prompt').notNull(),
  negativePrompt: text('negative_prompt'),
  provider:       text('provider').notNull(),
  aspect:         text('aspect').notNull().default('1:1'),
  megapixels:     real('megapixels').notNull().default(1.0),
  seed:           bigint('seed', { mode: 'number' }),
  referenceUrls:  jsonb('reference_urls').$type<string[]>().notNull().default([]),
  params:         jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  outputUrl:      text('output_url'),
  width:          integer('width'),
  height:         integer('height'),
  costUsd:        real('cost_usd').notNull().default(0),
  latencyMs:      integer('latency_ms'),
  status:         text('status').notNull().default('queued'),
  error:          text('error'),
  createdAt:      bigint('created_at', { mode: 'number' }).notNull(),
  endedAt:        bigint('ended_at', { mode: 'number' }),
}, (t) => [
  index('ipj_ws_idx').on(t.workspaceId, t.createdAt),
  index('ipj_status_idx').on(t.workspaceId, t.status),
])

export const imageUpscaleJob = pgTable('image_upscale_job', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  inputUrl:     text('input_url').notNull(),
  outputUrl:    text('output_url'),
  scaleFactor:  integer('scale_factor').notNull().default(4),
  provider:     text('provider').notNull().default('clarity'),
  detail:       real('detail').notNull().default(0.5),
  costUsd:      real('cost_usd').notNull().default(0),
  widthIn:      integer('width_in'),
  heightIn:     integer('height_in'),
  widthOut:     integer('width_out'),
  heightOut:    integer('height_out'),
  status:       text('status').notNull().default('queued'),
  error:        text('error'),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
  endedAt:      bigint('ended_at', { mode: 'number' }),
}, (t) => [index('iuj_ws_idx').on(t.workspaceId, t.createdAt)])

// ─── R146.176 — Video tactics analyzer ─────────────────────────────
export const videoTacticAnalysis = pgTable('video_tactic_analysis', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  sourceUrl:       text('source_url').notNull(),
  platform:        text('platform'),
  durationSec:     real('duration_sec'),
  isShortForm:     boolean('is_short_form').notNull().default(false),
  hook:            jsonb('hook').$type<Record<string, unknown>>().notNull().default({}),
  cuts:            jsonb('cuts').$type<Record<string, unknown>>().notNull().default({}),
  retention:       jsonb('retention').$type<Array<{ atSec: number; kind: string; desc: string }>>().notNull().default([]),
  engagement:      jsonb('engagement').$type<Record<string, unknown>>().notNull().default({}),
  captions:        jsonb('captions').$type<Record<string, unknown>>().notNull().default({}),
  audio:           jsonb('audio').$type<Record<string, unknown>>().notNull().default({}),
  platformSignals: jsonb('platform_signals').$type<Record<string, unknown>>().notNull().default({}),
  transcript:      text('transcript'),
  summary:         text('summary'),
  score:           real('score').notNull().default(0),
  costUsd:         real('cost_usd').notNull().default(0),
  status:          text('status').notNull().default('pending'),
  error:           text('error'),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
  analyzedAt:      bigint('analyzed_at', { mode: 'number' }),
}, (t) => [
  index('vta_ws_idx').on(t.workspaceId, t.createdAt),
  index('vta_ws_platform_idx').on(t.workspaceId, t.platform),
])

export const platformRankingPlaybook = pgTable('platform_ranking_playbook', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id'),
  platform:     text('platform').notNull(),
  form:         text('form').notNull(),
  rules:        jsonb('rules').$type<Array<{ rule: string; evidence?: string; weight: number }>>().notNull().default([]),
  version:      integer('version').notNull().default(1),
  sourceUrl:    text('source_url'),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
})

// ─── R146.177 — Browser humanizer + spend-lock + audit ─────────────
export const humanizerProfile = pgTable('humanizer_profile', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  accountId:        text('account_id'),
  typingWpmMin:     integer('typing_wpm_min').notNull().default(35),
  typingWpmMax:     integer('typing_wpm_max').notNull().default(75),
  mouseJitterPx:    integer('mouse_jitter_px').notNull().default(4),
  pauseMinMs:       integer('pause_min_ms').notNull().default(250),
  pauseMaxMs:       integer('pause_max_ms').notNull().default(1800),
  idleJitterMs:     integer('idle_jitter_ms').notNull().default(600),
  peakHours:        jsonb('peak_hours').$type<number[]>().notNull().default([]),
  dailyCaps:        jsonb('daily_caps').$type<Record<string, Record<string, number>>>().notNull().default({}),
  weekendFactor:    real('weekend_factor').notNull().default(1.15),
  status:           text('status').notNull().default('active'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [index('hp_ws_idx').on(t.workspaceId)])

export const browserActionLog = pgTable('browser_action_log', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  accountId:      text('account_id'),
  sessionId:      text('session_id').notNull(),
  platform:       text('platform'),
  kind:           text('kind').notNull(),
  target:         text('target'),
  args:           jsonb('args').$type<Record<string, unknown>>().notNull().default({}),
  result:         jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
  spendBlocked:   boolean('spend_blocked').notNull().default(false),
  tosWarning:     text('tos_warning'),
  pauseMsUsed:    integer('pause_ms_used'),
  success:        boolean('success').notNull().default(false),
  error:          text('error'),
  startedAt:      bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:        bigint('ended_at', { mode: 'number' }),
}, (t) => [
  index('bal_ws_idx').on(t.workspaceId, t.startedAt),
  index('bal_session_idx').on(t.sessionId, t.startedAt),
  index('bal_account_idx').on(t.accountId, t.startedAt),
])

// ─── R146.178 — Managed accounts + warmup ───────────────────────────
export const managedAccount = pgTable('managed_account', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  businessId:          text('business_id'),
  platform:            text('platform').notNull(),
  handle:              text('handle').notNull(),
  displayName:         text('display_name'),
  role:                text('role').notNull().default('primary'),
  vaultUserSecretId:   text('vault_user_secret_id').notNull(),
  vaultPassSecretId:   text('vault_pass_secret_id').notNull(),
  vaultTotpSecretId:   text('vault_totp_secret_id'),
  requires2fa:         boolean('requires_2fa').notNull().default(false),
  status:              text('status').notNull().default('creating'),
  warmupDayIndex:      integer('warmup_day_index').notNull().default(0),
  warmupStartedAt:     bigint('warmup_started_at', { mode: 'number' }),
  warmupCompletedAt:   bigint('warmup_completed_at', { mode: 'number' }),
  lastSigninAt:        bigint('last_signin_at', { mode: 'number' }),
  lastHealthAt:        bigint('last_health_at', { mode: 'number' }),
  health:              text('health').notNull().default('unknown'),
  signals:             jsonb('signals').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:           bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('ma_ws_platform_handle_idx').on(t.workspaceId, t.platform, t.handle),
  index('ma_ws_status_idx').on(t.workspaceId, t.status),
])

export const warmupPlan = pgTable('warmup_plan', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  accountId:    text('account_id').notNull(),
  platform:     text('platform').notNull(),
  dayCount:     integer('day_count').notNull(),
  curve:        jsonb('curve').$type<Array<{ day: number; targets: Array<{ kind: string; count: number }> }>>().notNull().default([]),
  startedAt:    bigint('started_at', { mode: 'number' }).notNull(),
  completedAt:  bigint('completed_at', { mode: 'number' }),
  status:       text('status').notNull().default('running'),
}, (t) => [
  index('wp_ws_idx').on(t.workspaceId),
  index('wp_account_idx').on(t.accountId),
])

export const warmupDay = pgTable('warmup_day', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  planId:       text('plan_id').notNull(),
  dayIndex:     integer('day_index').notNull(),
  targets:      jsonb('targets').$type<Array<{ kind: string; count: number }>>().notNull().default([]),
  completed:    jsonb('completed').$type<Record<string, number>>().notNull().default({}),
  status:       text('status').notNull().default('pending'),
  executedAt:   bigint('executed_at', { mode: 'number' }),
  error:        text('error'),
}, (t) => [uniqueIndex('wd_plan_day_idx').on(t.planId, t.dayIndex)])

// ─── R146.179 — POD social-traffic engine ──────────────────────────
export const podStore = pgTable('pod_store', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull(),
  businessId:          text('business_id'),
  platform:            text('platform').notNull(),
  domain:              text('domain'),
  niche:               text('niche'),
  brandName:           text('brand_name').notNull(),
  socialAccountIds:    jsonb('social_account_ids').$type<string[]>().notNull().default([]),
  status:              text('status').notNull().default('active'),
  createdAt:           bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('ps_ws_idx').on(t.workspaceId, t.status)])

export const podProduct = pgTable('pod_product', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  storeId:      text('store_id').notNull(),
  sku:          text('sku').notNull(),
  title:        text('title').notNull(),
  designUrl:    text('design_url'),
  category:     text('category'),
  tags:         jsonb('tags').$type<string[]>().notNull().default([]),
  priceCents:   integer('price_cents').notNull().default(0),
  costCents:    integer('cost_cents').notNull().default(0),
  marginCents:  integer('margin_cents').notNull().default(0),
  externalId:   text('external_id'),
  productUrl:   text('product_url'),
  soldCount:    integer('sold_count').notNull().default(0),
  revenueCents: integer('revenue_cents').notNull().default(0),
  status:       text('status').notNull().default('active'),
  listedAt:     bigint('listed_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('pp_store_sku_idx').on(t.storeId, t.sku),
  index('pp_ws_revenue_idx').on(t.workspaceId, t.revenueCents),
])

export const socialFunnelRoute = pgTable('social_funnel_route', {
  id:            text('id').primaryKey(),
  workspaceId:   text('workspace_id').notNull(),
  socialPostId:  text('social_post_id').notNull(),
  storeId:       text('store_id').notNull(),
  productId:     text('product_id'),
  utmCampaign:   text('utm_campaign').notNull(),
  utmSource:     text('utm_source'),
  utmMedium:     text('utm_medium'),
  shortUrl:      text('short_url'),
  clicks:        integer('clicks').notNull().default(0),
  conversions:   integer('conversions').notNull().default(0),
  revenueCents:  integer('revenue_cents').notNull().default(0),
  createdAt:     bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('sfr_post_store_idx').on(t.socialPostId, t.storeId),
  index('sfr_ws_idx').on(t.workspaceId, t.createdAt),
])

// ─── R146.180 — Money maximizer ─────────────────────────────────────
export const moneyOpportunity = pgTable('money_opportunity', {
  id:                    text('id').primaryKey(),
  workspaceId:           text('workspace_id').notNull(),
  businessId:            text('business_id'),
  kind:                  text('kind').notNull(),
  title:                 text('title').notNull(),
  estRevenueLiftCents:   integer('est_revenue_lift_cents').notNull().default(0),
  estHours:              real('est_hours').notNull().default(1),
  estCostCents:          integer('est_cost_cents').notNull().default(0),
  dollarsPerHour:        real('dollars_per_hour').notNull().default(0),
  confidence:            real('confidence').notNull().default(0.5),
  evidence:              jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  source:                text('source').notNull(),
  payload:               jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status:                text('status').notNull().default('open'),
  scheduledAt:           bigint('scheduled_at', { mode: 'number' }),
  completedAt:           bigint('completed_at', { mode: 'number' }),
  actualRevenueCents:    integer('actual_revenue_cents'),
  createdAt:             bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('mo_ws_idx').on(t.workspaceId, t.status, t.dollarsPerHour),
  index('mo_ws_created_idx').on(t.workspaceId, t.createdAt),
])

// ─── R146.181 — Self-pentest ───────────────────────────────────────
export const pentestRun = pgTable('pentest_run', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  targetBaseUrl:   text('target_base_url').notNull(),
  scope:           jsonb('scope').$type<string[]>().notNull().default([]),
  startedAt:       bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:         bigint('ended_at', { mode: 'number' }),
  status:          text('status').notNull().default('running'),
  findingsCount:   integer('findings_count').notNull().default(0),
  criticalsCount:  integer('criticals_count').notNull().default(0),
  triggeredBy:     text('triggered_by').notNull().default('manual'),
  error:           text('error'),
}, (t) => [index('prn_ws_idx').on(t.workspaceId, t.startedAt)])

export const pentestFinding = pgTable('pentest_finding', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  runId:        text('run_id').notNull(),
  severity:     text('severity').notNull(),
  category:     text('category').notNull(),
  title:        text('title').notNull(),
  endpoint:     text('endpoint'),
  evidence:     jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  remediation:  text('remediation'),
  status:       text('status').notNull().default('open'),
  fixedAt:      bigint('fixed_at', { mode: 'number' }),
  fixPr:        text('fix_pr'),
  foundAt:      bigint('found_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('pf_run_idx').on(t.runId),
  index('pf_ws_status_idx').on(t.workspaceId, t.status, t.severity),
])

// ─── R146.182 — Voice layer ─────────────────────────────────────────
export const voicePersona = pgTable('voice_persona', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  name:             text('name').notNull(),
  wakeWord:         text('wake_word').notNull().default('hey novan'),
  voiceId:          text('voice_id').notNull(),
  voiceProvider:    text('voice_provider').notNull().default('elevenlabs'),
  personaPrompt:    text('persona_prompt').notNull(),
  tone:             text('tone').notNull().default('precise'),
  responseSpeed:    text('response_speed').notNull().default('normal'),
  proactiveEnabled: boolean('proactive_enabled').notNull().default(true),
  alwaysOn:         boolean('always_on').notNull().default(false),
  status:           text('status').notNull().default('active'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt:        bigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('vp_ws_idx').on(t.workspaceId, t.name)])

export const sessionSync = pgTable('session_sync', {
  id:               text('id').primaryKey(),
  workspaceId:      text('workspace_id').notNull(),
  userId:           text('user_id').notNull(),
  deviceId:         text('device_id').notNull(),
  deviceKind:       text('device_kind'),
  activeChatId:     text('active_chat_id'),
  draftInput:       text('draft_input'),
  draftVoiceState:  jsonb('draft_voice_state').$type<Record<string, unknown>>().notNull().default({}),
  lastPingAt:       bigint('last_ping_at', { mode: 'number' }).notNull(),
  lastHandoffTo:    text('last_handoff_to'),
  createdAt:        bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  uniqueIndex('ss_user_device_idx').on(t.workspaceId, t.userId, t.deviceId),
  index('ss_user_ping_idx').on(t.workspaceId, t.userId, t.lastPingAt),
])

// ─── R146.183 — Proactive + radar ──────────────────────────────────
export const proactiveSignal = pgTable('proactive_signal', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  kind:         text('kind').notNull(),
  severity:     text('severity').notNull().default('normal'),
  summary:      text('summary').notNull(),
  payload:      jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  firedAt:      bigint('fired_at', { mode: 'number' }),
  ackedAt:      bigint('acked_at', { mode: 'number' }),
  dismissedAt:  bigint('dismissed_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('ps_ws_unfired_idx').on(t.workspaceId, t.firedAt, t.severity),
  index('ps_ws_created_idx').on(t.workspaceId, t.createdAt),
])

export const threatRadarSnapshot = pgTable('threat_radar_snapshot', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  scanAt:         bigint('scan_at', { mode: 'number' }).notNull(),
  openTotal:      integer('open_total').notNull().default(0),
  criticalCount:  integer('critical_count').notNull().default(0),
  highCount:      integer('high_count').notNull().default(0),
  bySource:       jsonb('by_source').$type<Record<string, number>>().notNull().default({}),
  byCategory:     jsonb('by_category').$type<Record<string, number>>().notNull().default({}),
}, (t) => [index('trs_ws_idx').on(t.workspaceId, t.scanAt)])

// ─── R146.184 — Physical bridges ───────────────────────────────────
export const physicalEndpoint = pgTable('physical_endpoint', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  kind:            text('kind').notNull(),
  label:           text('label').notNull(),
  baseUrl:         text('base_url').notNull(),
  vaultSecretId:   text('vault_secret_id'),
  metadata:        jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  status:          text('status').notNull().default('active'),
  lastSeenAt:      bigint('last_seen_at', { mode: 'number' }),
  createdAt:       bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [index('pe_ws_kind_idx').on(t.workspaceId, t.kind, t.status)])

export const physicalActionLog = pgTable('physical_action_log', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  endpointId:   text('endpoint_id').notNull(),
  kind:         text('kind').notNull(),
  payload:      jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  result:       jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
  success:      boolean('success').notNull().default(false),
  error:        text('error'),
  startedAt:    bigint('started_at', { mode: 'number' }).notNull(),
  endedAt:      bigint('ended_at', { mode: 'number' }),
}, (t) => [index('pal_ws_idx').on(t.workspaceId, t.startedAt)])

export const biometricEvent = pgTable('biometric_event', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  userId:       text('user_id'),
  source:       text('source').notNull(),
  kind:         text('kind').notNull(),
  value:        jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  unit:         text('unit'),
  recordedAt:   bigint('recorded_at', { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('be_ws_kind_idx').on(t.workspaceId, t.kind, t.recordedAt),
  index('be_ws_source_idx').on(t.workspaceId, t.source, t.recordedAt),
])

// ─── R146.185 — Tier B Jarvis-gap features ─────────────────────────
export const companionSession = pgTable('companion_session', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  name:         text('name').notNull(),
  personaId:    text('persona_id'),
  modelTier:    text('model_tier').notNull().default('light'),
  status:       text('status').notNull().default('active'),
  lastUsedAt:   bigint('last_used_at', { mode: 'number' }),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('cs_ws_name_idx').on(t.workspaceId, t.name)])

export const signalClassification = pgTable('signal_classification', {
  id:              text('id').primaryKey(),
  workspaceId:     text('workspace_id').notNull(),
  source:          text('source').notNull(),
  externalRef:     text('external_ref'),
  contentExcerpt:  text('content_excerpt').notNull(),
  kind:            text('kind').notNull(),
  score:           real('score').notNull().default(0),
  evidence:        jsonb('evidence').$type<Record<string, unknown>>().notNull().default({}),
  classifiedAt:    bigint('classified_at', { mode: 'number' }).notNull(),
}, (t) => [
  index('scn_ws_idx').on(t.workspaceId, t.classifiedAt),
  index('scn_ws_kind_idx').on(t.workspaceId, t.kind),
])

export const tacticalSimRun = pgTable('tactical_sim_run', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  scenario:     text('scenario').notNull(),
  assumptions:  jsonb('assumptions').$type<Record<string, unknown>>().notNull().default({}),
  trials:       integer('trials').notNull().default(1000),
  results:      jsonb('results').$type<Record<string, unknown>>().notNull().default({}),
  status:       text('status').notNull().default('done'),
  ranAt:        bigint('ran_at', { mode: 'number' }).notNull(),
}, (t) => [index('tsr_ws_idx').on(t.workspaceId, t.ranAt)])

export const xrScene = pgTable('xr_scene', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull(),
  name:         text('name').notNull(),
  sceneJson:    jsonb('scene_json').$type<Record<string, unknown>>().notNull().default({}),
  arEnabled:    boolean('ar_enabled').notNull().default(true),
  vrEnabled:    boolean('vr_enabled').notNull().default(true),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
  createdAt:    bigint('created_at', { mode: 'number' }).notNull(),
}, (t) => [uniqueIndex('xr_ws_name_idx').on(t.workspaceId, t.name)])

// ─── R146.191 — Feature flags ──────────────────────────────────────
export const featureFlag = pgTable('feature_flag', {
  key:          text('key').primaryKey(),
  enabled:      boolean('enabled').notNull().default(true),
  description:  text('description'),
  updatedAt:    bigint('updated_at', { mode: 'number' }).notNull(),
  updatedBy:    text('updated_by'),
})
