CREATE TYPE "public"."agent_status" AS ENUM('idle', 'running', 'paused', 'error', 'offline');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('draft', 'active', 'paused', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('1', '2', '3', '4', '5');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('observation', 'decision', 'lesson', 'goal', 'idea', 'fact', 'strategic', 'operational');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('identified', 'evaluating', 'active', 'won', 'lost', 'deferred', 'accepted', 'rejected', 'stale', 'completed');--> statement-breakpoint
CREATE TYPE "public"."risk_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped', 'retrying');--> statement-breakpoint
CREATE TYPE "public"."workflow_status" AS ENUM('pending', 'running', 'paused', 'completed', 'failed', 'cancelled', 'awaiting_approval');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_ref" text NOT NULL,
	"vault_secret_id" text,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"subject_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"requested_by" text NOT NULL,
	"approval_id" text,
	"result" jsonb,
	"error" text,
	"created_at" bigint NOT NULL,
	"started_at" bigint,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"task_kind" text NOT NULL,
	"task_ref" text NOT NULL,
	"status" text DEFAULT 'assigned' NOT NULL,
	"depends_on" text[] DEFAULT '{}' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"assigned_at" bigint NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"error_message" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"department" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"emoji" text,
	"vibe" text,
	"system_prompt" text NOT NULL,
	"source_path" text,
	"checksum" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_delegations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"definition_id" text NOT NULL,
	"department" text NOT NULL,
	"task" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" text,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"provider" text,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text DEFAULT 'ceo' NOT NULL,
	"reasoning_chain_id" text,
	"started_at" bigint,
	"completed_at" bigint,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_pause_state" (
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_by" text,
	"paused_at" bigint,
	"reason" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_pause_state_workspace_id_agent_name_pk" PRIMARY KEY("workspace_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"last_heartbeat" bigint NOT NULL,
	"active_assignments" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"rollback_count" integer DEFAULT 0 NOT NULL,
	"registered_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"status" "agent_status" DEFAULT 'idle' NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_active_at" bigint,
	"heartbeat_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_response_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"cache_key" text NOT NULL,
	"model" text NOT NULL,
	"task_type" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"response_tokens" integer DEFAULT 0 NOT NULL,
	"response" text NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"last_hit_at" bigint,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"task_type" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"trace_id" text,
	"workflow_run_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anomaly_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"score" real NOT NULL,
	"subject" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"acked_at" bigint,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{"read","write"}' NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"status" text NOT NULL,
	"requested_by" text NOT NULL,
	"resolved_by" text,
	"requested_at" bigint NOT NULL,
	"resolved_at" bigint,
	"expires_at" bigint NOT NULL,
	"operation_label" text NOT NULL,
	"risk" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"resolved_by" text,
	"resolved_at" bigint,
	"operation_label" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "archive_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"table_name" text NOT NULL,
	"rows_archived" integer NOT NULL,
	"archived_through_ts" bigint NOT NULL,
	"elapsed_ms" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assumptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"statement" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"confidence_provenance" text DEFAULT 'heuristic' NOT NULL,
	"status" text DEFAULT 'unverified' NOT NULL,
	"source" text NOT NULL,
	"last_verified_at" bigint,
	"last_invalidated_at" bigint,
	"verification_count" integer DEFAULT 0 NOT NULL,
	"invalidation_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"format" text DEFAULT 'json' NOT NULL,
	"from_ts" bigint NOT NULL,
	"to_ts" bigint NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"download_ref" text,
	"created_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"pattern_id" text NOT NULL,
	"file_path" text NOT NULL,
	"line_number" integer DEFAULT 1 NOT NULL,
	"matched_text" text NOT NULL,
	"description" text NOT NULL,
	"suggestion" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"root_path" text NOT NULL,
	"files_scanned" integer DEFAULT 0 NOT NULL,
	"finding_count" integer DEFAULT 0 NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"high_count" integer DEFAULT 0 NOT NULL,
	"task_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomous_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"phase" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"bullmq_job_id" text,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_message" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autonomous_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text,
	"master_prompt" text NOT NULL,
	"current_agent" text,
	"active_job_id" text,
	"last_event" text,
	"failure_reason" text,
	"verification_results" jsonb,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefing_items" (
	"id" text PRIMARY KEY NOT NULL,
	"briefing_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"section" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"is_low_confidence" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"source_label" text,
	"converted" boolean DEFAULT false NOT NULL,
	"converted_at" bigint,
	"converted_run_id" text,
	"converted_workflow_id" text,
	"priority" integer DEFAULT 50 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "briefings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"requested_by" text DEFAULT 'system' NOT NULL,
	"trace_id" text NOT NULL,
	"window_ms" bigint DEFAULT 86400000 NOT NULL,
	"summary" text,
	"error_message" text,
	"generated_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"action_type" text NOT NULL,
	"action_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success" boolean DEFAULT false NOT NULL,
	"output" jsonb,
	"error" text,
	"screenshot_path" text,
	"duration_ms" integer,
	"executed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"run_id" text,
	"step_id" text,
	"trace_id" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"page_title" text,
	"page_text" text,
	"screenshot_path" text,
	"error_message" text,
	"duration_ms" integer,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"alert_type" text NOT NULL,
	"threshold_pct" real NOT NULL,
	"current_usd" real NOT NULL,
	"limit_usd" real NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"dismissed_at" bigint,
	"fired_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "budget_caps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"max_daily_usd" real DEFAULT 0 NOT NULL,
	"max_monthly_usd" real DEFAULT 0 NOT NULL,
	"max_per_execution_usd" real DEFAULT 0 NOT NULL,
	"max_workflow_usd" real DEFAULT 0 NOT NULL,
	"current_daily_usd" real DEFAULT 0 NOT NULL,
	"current_monthly_usd" real DEFAULT 0 NOT NULL,
	"daily_reset_at" bigint NOT NULL,
	"monthly_reset_at" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "build_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_run_id" text NOT NULL,
	"finding_id" text,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"assigned_agent" text,
	"blast_radius" text DEFAULT 'low' NOT NULL,
	"file_path" text,
	"autonomous_job_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_systems" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text NOT NULL,
	"kind" text NOT NULL,
	"layer" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"status" text DEFAULT 'forming' NOT NULL,
	"agent_slug" text,
	"parent_id" text,
	"position" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "businesses" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"stage" text DEFAULT 'early' NOT NULL,
	"health" text DEFAULT 'green' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dna" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vision" text,
	"brief" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_embeddings" (
	"chain_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"vector" text NOT NULL,
	"dim" integer NOT NULL,
	"source_kind" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"action_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"executed_action_id" text,
	"executed_result" jsonb,
	"decided_by" text,
	"decided_at" bigint,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_patches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agent" text DEFAULT 'template' NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sandbox_report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"block_reason" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd_used" real DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"build_plan_id" text,
	"capability_id" text,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"files_to_create" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"files_to_modify" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tests_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"estimated_loc" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"reasoning" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"shipped_at" bigint,
	"shipped_commit_sha" text,
	"shipped_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "code_state_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"git_sha" text NOT NULL,
	"branch" text,
	"commit_message" text,
	"files_changed" integer DEFAULT 0 NOT NULL,
	"committed_at" bigint NOT NULL,
	"captured_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"url" text,
	"action_text" text,
	"screenshot_path" text,
	"requires_confirm" boolean DEFAULT false NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"occurred_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commerce_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_ref" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_id" text,
	"events_count" integer DEFAULT 0 NOT NULL,
	"screenshots_taken" integer DEFAULT 0 NOT NULL,
	"started_at" bigint,
	"ended_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commit_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"git_sha" text NOT NULL,
	"evaluated_at" bigint NOT NULL,
	"horizon_days" integer DEFAULT 7 NOT NULL,
	"incidents_after" integer DEFAULT 0 NOT NULL,
	"drift_warnings_after" integer DEFAULT 0 NOT NULL,
	"match_rate_delta" real,
	"verdict" text NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "communication_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"output_type" text NOT NULL,
	"text" text NOT NULL,
	"hype_score" real DEFAULT 0 NOT NULL,
	"uncertainty_handling" text NOT NULL,
	"fact_estimate_ok" boolean DEFAULT true NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passed" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compressed_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"abstracted_lesson" text,
	"source_table" text NOT NULL,
	"source_refs" text[] DEFAULT '{}' NOT NULL,
	"source_count" integer NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"confidence_provenance" text DEFAULT 'heuristic' NOT NULL,
	"embedding" vector(768),
	"archived_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"label" text NOT NULL,
	"external_account" text,
	"secret_ref" text,
	"granted_scopes" text[] DEFAULT '{}' NOT NULL,
	"permission" text DEFAULT 'read' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"health" text DEFAULT 'unknown' NOT NULL,
	"last_action_at" bigint,
	"last_health_at" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text DEFAULT 'operator' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"action" text NOT NULL,
	"intent" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"blocked_reason" text,
	"dry_run_preview" jsonb,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approved_by" text,
	"approved_at" bigint,
	"rejected_by" text,
	"rejected_at" bigint,
	"rejection_reason" text,
	"started_at" bigint,
	"completed_at" bigint,
	"result" jsonb,
	"error_message" text,
	"initiated_by" text NOT NULL,
	"correlation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_kill_switches" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"all_blocked" boolean DEFAULT false NOT NULL,
	"category_blocked" text[] DEFAULT '{}' NOT NULL,
	"connector_blocked" text[] DEFAULT '{}' NOT NULL,
	"reason" text,
	"set_by" text,
	"set_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_rate_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text,
	"action" text,
	"max_per_minute" integer DEFAULT 60 NOT NULL,
	"max_per_hour" integer DEFAULT 600 NOT NULL,
	"set_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"auth_type" text NOT NULL,
	"default_scopes" text[] DEFAULT '{}' NOT NULL,
	"optional_scopes" text[] DEFAULT '{}' NOT NULL,
	"supported_actions" text[] DEFAULT '{}' NOT NULL,
	"blocked_actions" text[] DEFAULT '{}' NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"implemented" boolean DEFAULT false NOT NULL,
	"official_website_url" text,
	"signup_url" text,
	"login_url" text,
	"oauth_authorization_url" text,
	"developer_app_setup_url" text,
	"api_key_creation_url" text,
	"docs_url" text,
	"pricing_url" text,
	"status_page_url" text,
	"permission_explanation" text,
	"account_required" boolean DEFAULT true NOT NULL,
	"supports_oauth" boolean DEFAULT false NOT NULL,
	"supports_api_key" boolean DEFAULT false NOT NULL,
	"supports_session_auth" boolean DEFAULT false NOT NULL,
	"free_tier_available" boolean DEFAULT false NOT NULL,
	"metadata_verified_at" bigint,
	"icon_key" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"forked_from_conversation_id" text,
	"forked_from_message_id" text,
	"branch_root_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cron_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"cron_name" text NOT NULL,
	"window_start" bigint NOT NULL,
	"calls_used" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_usd_used" real DEFAULT 0 NOT NULL,
	"max_calls" integer DEFAULT 1000 NOT NULL,
	"max_tokens" integer DEFAULT 1000000 NOT NULL,
	"max_cost_usd" real DEFAULT 5 NOT NULL,
	"window_ms" bigint DEFAULT 3600000 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"last_blocked_at" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "cron_budgets_cron_name_unique" UNIQUE("cron_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dead_letter_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" text NOT NULL,
	"job_name" text NOT NULL,
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text NOT NULL,
	"trace_id" text,
	"first_failed_at" bigint NOT NULL,
	"dead_lettered_at" bigint NOT NULL,
	"replayed_at" bigint,
	"replayed_by" text,
	"replay_run_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_concepts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"brief" text NOT NULL,
	"prompt" text NOT NULL,
	"asset_image_ref" text,
	"originality_score" real,
	"ip_risk_score" real,
	"slop_score" real,
	"quality_score" real,
	"trend_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"block_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovered_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"service_file" text NOT NULL,
	"exports_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"maturity" text DEFAULT 'basic' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drift_warnings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text,
	"severity" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"applied_action" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "duplicate_merge_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"primary_id" text NOT NULL,
	"duplicate_id" text NOT NULL,
	"similarity" real NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"decided_by" text,
	"decided_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "endpoint_usage_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"model" text NOT NULL,
	"task_type" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"streamed" boolean DEFAULT false NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ethical_blocks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"intent" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"blocked_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"type" text NOT NULL,
	"workspace_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"trace_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"causation_id" text,
	"source" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_guards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"estimated_cost_usd" real DEFAULT 0 NOT NULL,
	"decision" text NOT NULL,
	"block_reason" text,
	"cap_id" text,
	"actual_cost_usd" real,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text NOT NULL,
	"job_type" text DEFAULT 'ai' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"renewed_at" bigint,
	"completed_at" bigint,
	"reclaimed_at" bigint,
	"timeout_ms" integer DEFAULT 300000 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workflow_run_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"lock_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"holder_id" text NOT NULL,
	"holder_kind" text DEFAULT 'agent' NOT NULL,
	"acquired_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"released_at" bigint,
	"recovered_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "executive_review_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"cycle" text NOT NULL,
	"triggered_by" text NOT NULL,
	"signals_analyzed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priorities_before" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priorities_after" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions_recommended" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "executive_state" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"top_priorities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategic_objectives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_initiatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_posture" jsonb,
	"reliability_posture" jsonb,
	"security_posture" jsonb,
	"focus_areas" text[] DEFAULT '{}' NOT NULL,
	"last_review_at" bigint,
	"review_count" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_feeds" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"feed_url" text NOT NULL,
	"name" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"interval_seconds" integer DEFAULT 3600 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_polled_at" bigint,
	"last_success_at" bigint,
	"last_error" text,
	"items_ingested" integer DEFAULT 0 NOT NULL,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"max_items_per_poll" integer DEFAULT 5 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"fetched_at" bigint NOT NULL,
	"status" integer NOT NULL,
	"content_type" text,
	"content_redacted" text NOT NULL,
	"content_bytes" integer DEFAULT 0 NOT NULL,
	"secrets_redacted" integer DEFAULT 0 NOT NULL,
	"title" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"expires_at" bigint,
	"fetched_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "failure_lineages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"root_cause" text,
	"failure_chain" jsonb NOT NULL,
	"affected_steps" text[] DEFAULT '{}' NOT NULL,
	"recovery_attempts" integer DEFAULT 0 NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "failure_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"failure_type" text NOT NULL,
	"root_cause_class" text NOT NULL,
	"target_ref" text NOT NULL,
	"target_kind" text NOT NULL,
	"signature" text NOT NULL,
	"error_pattern" text NOT NULL,
	"agent_id" text,
	"evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"attempted_fix_ids" text[] DEFAULT '{}' NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"surface" text,
	"severity" text DEFAULT 'normal' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reported_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"raw" text NOT NULL,
	"fingerprint" text NOT NULL,
	"category" text,
	"target_user" text,
	"pain_point" text,
	"solution" text,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monetization" text,
	"tech_stack" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"demand_score" integer,
	"difficulty_score" integer,
	"build_readiness" integer,
	"upside_score" integer,
	"risk_score" integer,
	"source_type" text NOT NULL,
	"source_ref" text,
	"source_excerpt" text,
	"status" text DEFAULT 'raw' NOT NULL,
	"promoted_to_business_id" text,
	"promoted_at" bigint,
	"archived_at" bigint,
	"rejected_reason" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identity_profile" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"traits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tone_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"prompt" text NOT NULL,
	"enhanced_prompt" text,
	"negative_prompt" text,
	"provider" text NOT NULL,
	"model" text,
	"style_preset" text,
	"aspect_ratio" text,
	"width" integer,
	"height" integer,
	"seed" integer,
	"batch_id" text,
	"source_image_ref" text,
	"brand_category" text,
	"cost_estimate_usd" real DEFAULT 0 NOT NULL,
	"actual_cost_usd" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocked_reason" text,
	"image_url" text,
	"image_path" text,
	"provider_response" jsonb,
	"error_message" text,
	"user_rating" integer,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"quality_score" real,
	"slop_risk_score" real,
	"originality_score" real,
	"composition_score" real,
	"brand_fit_score" real,
	"creative_flags" jsonb,
	"router_provenance" text,
	"latency_ms" integer,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"completed_at" bigint,
	"trace_id" text,
	"workflow_run_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "image_quality_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"kind" text NOT NULL,
	"verdict" text NOT NULL,
	"composite" real NOT NULL,
	"quality_score" real NOT NULL,
	"slop_risk" real NOT NULL,
	"originality" real NOT NULL,
	"composition" real NOT NULL,
	"brand_fit" real NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text,
	"from_addr" text,
	"subject" text,
	"body" text NOT NULL,
	"received_at" bigint NOT NULL,
	"processed_at" bigint,
	"intent" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incident_timeline" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"action_type" text NOT NULL,
	"actor" text DEFAULT 'system' NOT NULL,
	"note" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"root_cause_hypothesis" text,
	"affected_systems" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_event_ids" text[] DEFAULT '{}' NOT NULL,
	"signal_count" integer DEFAULT 0 NOT NULL,
	"recommended_action" text,
	"assigned_agent" text,
	"repair_task_id" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" bigint,
	"resolved_by" text,
	"resolved_at" bigint,
	"resolution_note" text,
	"escalated_at" bigint,
	"escalation_reason" text,
	"detected_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insights" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text DEFAULT 'operational' NOT NULL,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(1536),
	"dismissed" boolean DEFAULT false NOT NULL,
	"acted_on" boolean DEFAULT false NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issues" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"symptom" text NOT NULL,
	"root_cause" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_systems" text[] DEFAULT '{}' NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"risk_level" text,
	"proposed_fix" text,
	"verification_plan" text,
	"rollback_plan" text,
	"status" text DEFAULT 'open' NOT NULL,
	"source" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_incident_id" text,
	"source_event_id" text,
	"proposal_id" text,
	"patch_id" text,
	"commit_sha" text,
	"created_by" text DEFAULT 'system' NOT NULL,
	"diagnosed_by" text,
	"closed_by" text,
	"detected_at" bigint NOT NULL,
	"diagnosed_at" bigint,
	"closed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kill_switches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"switch_type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reason" text,
	"enabled_by" text,
	"enabled_at" bigint,
	"disabled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"readiness_score" integer DEFAULT 0 NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"unverified_count" integer DEFAULT 0 NOT NULL,
	"critical_blockers" integer DEFAULT 0 NOT NULL,
	"check_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_fixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" text DEFAULT 'system' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "launch_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"locked" boolean DEFAULT true NOT NULL,
	"blocking_reasons" text[] DEFAULT '{}' NOT NULL,
	"last_audit_id" text,
	"last_audit_score" integer,
	"override_active" boolean DEFAULT false NOT NULL,
	"override_by" text,
	"override_reason" text,
	"override_at" bigint,
	"override_expires_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"insight_id" text,
	"action" text NOT NULL,
	"outcome" text,
	"outcome_notes" text,
	"user_id" text,
	"delta_metric" real,
	"metric_name" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_required" boolean DEFAULT false NOT NULL,
	"approved" boolean,
	"approved_by" text,
	"approved_at" bigint,
	"pattern_id" text,
	"embedding" vector(768),
	"status" text DEFAULT 'pending_review' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"pattern_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"confidence" real NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"score_type" text NOT NULL,
	"score_value" real NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sample_count" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text,
	"source_workflow_id" text,
	"source_run_id" text,
	"source_memory_id" text,
	"signal" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"review_required" boolean DEFAULT false NOT NULL,
	"pattern_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memories" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"embedding" vector(1536),
	"confidence" real DEFAULT 1 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"member_memory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"centroid" vector(768),
	"member_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"chunk_text" text NOT NULL,
	"embedding" vector(768),
	"embedding_model" text DEFAULT 'nomic-embed-text' NOT NULL,
	"is_stale" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audit" jsonb,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"provider" text,
	"model" text,
	"stream_complete" boolean DEFAULT true NOT NULL,
	"error" text,
	"superseded_at" bigint,
	"superseded_by" text,
	"regenerated_from" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_quality_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"task_type" text NOT NULL,
	"score_value" real NOT NULL,
	"sample_count" integer DEFAULT 1 NOT NULL,
	"latency_p50" real,
	"latency_p99" real,
	"error_rate" real DEFAULT 0 NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_prefs" (
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"severity_floor" text DEFAULT 'normal' NOT NULL,
	"muted_until" bigint,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "notification_prefs_workspace_id_type_pk" PRIMARY KEY("workspace_id","type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text DEFAULT 'info' NOT NULL,
	"category" text DEFAULT 'system' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"source_type" text,
	"source_id" text,
	"action_url" text,
	"expires_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_load_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"window_ms" bigint NOT NULL,
	"event_volume" integer NOT NULL,
	"alert_volume" integer NOT NULL,
	"pending_count" integer NOT NULL,
	"interruption_rate" real NOT NULL,
	"load_score" real NOT NULL,
	"mode" text NOT NULL,
	"recommendation" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_preferences" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"default_page" text,
	"max_concurrent_agents" integer,
	"max_research_per_hour" integer,
	"max_images_per_hour" integer,
	"max_autonomous_patches_per_day" integer,
	"max_deployments_per_day" integer,
	"approval_auto_apply_min_confidence" real DEFAULT 0.8 NOT NULL,
	"risk_tolerance" text DEFAULT 'balanced' NOT NULL,
	"drift_correction_policy" text DEFAULT 'balanced' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_presence" (
	"workspace_id" text NOT NULL,
	"operator_id" text DEFAULT 'default' NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"last_polled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "operator_voice_prefs" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"preferred_voice" text,
	"preferred_speed" real DEFAULT 1 NOT NULL,
	"preferred_length" text DEFAULT 'short' NOT NULL,
	"confirmation_style" text DEFAULT 'chip' NOT NULL,
	"preferred_wake" text,
	"preferred_default_mode" text DEFAULT 'push_to_talk' NOT NULL,
	"response_mode" text DEFAULT 'normal' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "operator_voice_prefs_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opportunities" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text,
	"title" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'operational' NOT NULL,
	"status" "opportunity_status" DEFAULT 'identified' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"value_potential" real,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"category" text DEFAULT 'growth' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"estimated_roi" real,
	"estimated_effort" text,
	"risk_level" text,
	"strategic_alignment" real,
	"score" real,
	"score_breakdown" jsonb,
	"linked_memory_ids" text[] DEFAULT '{}' NOT NULL,
	"linked_workflow_ids" text[] DEFAULT '{}' NOT NULL,
	"converted_run_id" text,
	"converted_workflow_id" text,
	"converted_at" bigint,
	"accepted_at" bigint,
	"rejected_at" bigint,
	"due_date" bigint,
	"closed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "optimization_recommendations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"impact" integer DEFAULT 50 NOT NULL,
	"risk" integer DEFAULT 50 NOT NULL,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"recommended_agent" text,
	"dismissed_reason" text,
	"detected_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "override_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"action_type" text NOT NULL,
	"subject_id" text,
	"original_status" text NOT NULL,
	"override_status" text NOT NULL,
	"operator_id" text,
	"reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "patch_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"audit_run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"risk_level" text NOT NULL,
	"risk_categories" text[] DEFAULT '{}' NOT NULL,
	"risk_reason" text NOT NULL,
	"task_title" text NOT NULL,
	"file_path" text,
	"affected_files" text[] DEFAULT '{}' NOT NULL,
	"diff_preview" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewer_id" text,
	"reviewer_note" text,
	"reviewed_at" bigint,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "patch_records" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"file_path" text NOT NULL,
	"original_content" text NOT NULL,
	"patched_content" text NOT NULL,
	"lines_added" integer DEFAULT 0 NOT NULL,
	"lines_removed" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"rolled_back_at" bigint,
	"rollback_reason" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"grants" text[] DEFAULT '{}' NOT NULL,
	"granted_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"monthly_price_usd" integer DEFAULT 0 NOT NULL,
	"seat_limit" integer DEFAULT 1 NOT NULL,
	"workflow_limit" integer DEFAULT 5 NOT NULL,
	"workspace_limit" integer DEFAULT 1 NOT NULL,
	"monthly_token_limit" integer DEFAULT 100000 NOT NULL,
	"monthly_spend_limit_usd" integer DEFAULT 10 NOT NULL,
	"feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_smoke_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"ran_at" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"slow_count" integer DEFAULT 0 NOT NULL,
	"probes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"regressions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'cron' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pod_listings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"concept_id" text,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"asset_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"quality_score" real,
	"performance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"policy_name" text NOT NULL,
	"action" text NOT NULL,
	"verdict" text NOT NULL,
	"risk_level" text NOT NULL,
	"agent_id" text,
	"checked_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posting_governor" (
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_ref" text NOT NULL,
	"posts_today" integer DEFAULT 0 NOT NULL,
	"max_per_day" integer DEFAULT 5 NOT NULL,
	"cooldown_min" integer DEFAULT 45 NOT NULL,
	"last_post_at" bigint,
	"window_start" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "posting_governor_workspace_id_platform_account_ref_pk" PRIMARY KEY("workspace_id","platform","account_ref")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prompt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'image' NOT NULL,
	"brand_category" text,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"default_provider" text,
	"default_model" text,
	"default_aspect_ratio" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"daily_limit_usd" real DEFAULT 10 NOT NULL,
	"weekly_limit_usd" real DEFAULT 0 NOT NULL,
	"monthly_limit_usd" real DEFAULT 100 NOT NULL,
	"daily_spend_usd" real DEFAULT 0 NOT NULL,
	"weekly_spend_usd" real DEFAULT 0 NOT NULL,
	"monthly_spend_usd" real DEFAULT 0 NOT NULL,
	"daily_reset_at" bigint NOT NULL,
	"weekly_reset_at" bigint,
	"monthly_reset_at" bigint NOT NULL,
	"alert_threshold" real DEFAULT 0.8 NOT NULL,
	"max_per_job_usd" real DEFAULT 0 NOT NULL,
	"max_browser_session_secs" integer DEFAULT 0 NOT NULL,
	"max_ai_request_secs" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 10 NOT NULL,
	"max_concurrent_remote" integer DEFAULT 5 NOT NULL,
	"hard_stop" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "provider_budgets_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_iv" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"max_cost_per_req_usd" real,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"endpoint_id" text,
	"task_type" text NOT NULL,
	"model" text NOT NULL,
	"error_type" text NOT NULL,
	"error_message" text NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"fallback_provider_id" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"latency_ms" real,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_health_log" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"source_type" text DEFAULT 'provider' NOT NULL,
	"status" text NOT NULL,
	"latency_ms" real,
	"error_rate" real DEFAULT 0 NOT NULL,
	"checked_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_preferences" (
	"workspace_id" text NOT NULL,
	"task_type" text NOT NULL,
	"preferred_provider" text NOT NULL,
	"set_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "provider_preferences_workspace_id_task_type_pk" PRIMARY KEY("workspace_id","task_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_quarantine" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"reason" text NOT NULL,
	"quarantined_at" bigint NOT NULL,
	"release_at" bigint,
	"released_at" bigint,
	"auto_release" boolean DEFAULT false NOT NULL,
	"released_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"latency_score" real DEFAULT 1 NOT NULL,
	"success_score" real DEFAULT 1 NOT NULL,
	"cost_score" real DEFAULT 1 NOT NULL,
	"capability_score" real DEFAULT 1 NOT NULL,
	"composite_score" real DEFAULT 1 NOT NULL,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"last_latency_ms" real,
	"last_error_rate" real DEFAULT 0 NOT NULL,
	"circuit_state" text DEFAULT 'closed' NOT NULL,
	"circuit_opened_at" bigint,
	"circuit_failures" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"queue_name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"reason" text,
	"paused_by" text,
	"paused_at" bigint,
	"resumed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "queue_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"trace_id" text NOT NULL,
	"queue_name" text NOT NULL,
	"job_id" text NOT NULL,
	"job_name" text NOT NULL,
	"event" text NOT NULL,
	"duration_ms" integer,
	"attempt" integer,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reasoning_chains" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_id" text,
	"decision" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tradeoffs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"prediction" jsonb,
	"outcome_known" boolean DEFAULT false NOT NULL,
	"outcome_matched" boolean,
	"outcome_evidence" jsonb,
	"outcome_at" bigint,
	"source" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recommendation_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"chain_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"operator_id" text,
	"weight_delta" real DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recommendation_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"recommendation_id" text NOT NULL,
	"insight_id" text,
	"outcome" text NOT NULL,
	"delta_metric" real,
	"metric_name" text,
	"notes" text,
	"executed_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recovery_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"completed_steps" text[] DEFAULT '{}' NOT NULL,
	"state" jsonb NOT NULL,
	"snapshot_id" text,
	"restored_at" bigint,
	"restored_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "recovery_log" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"strategy" text NOT NULL,
	"reason" text NOT NULL,
	"steps" jsonb NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "remote_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_iv" text,
	"custom_headers_encrypted" text,
	"custom_headers_iv" text,
	"model_ids" text[] DEFAULT '{}' NOT NULL,
	"max_context_tokens" integer DEFAULT 8192 NOT NULL,
	"prompt_per_1k_usd" real DEFAULT 0 NOT NULL,
	"output_per_1k_usd" real DEFAULT 0 NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 10 NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_health_check" bigint,
	"latency_ms" real,
	"model_count" integer DEFAULT 0 NOT NULL,
	"last_model_discovery" bigint,
	"last_discovery_error" text,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_divergences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"replay_run_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"expected_state" jsonb NOT NULL,
	"actual_state" jsonb NOT NULL,
	"divergence_type" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"checkpoint_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"replayed_count" integer DEFAULT 0 NOT NULL,
	"diverged_at_event_id" text,
	"divergence_reason" text,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"root_path" text NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_lines" integer DEFAULT 0 NOT NULL,
	"file_tree" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic_id" text,
	"agent_id" text,
	"source_url" text NOT NULL,
	"source_title" text,
	"fact_type" text DEFAULT 'fact' NOT NULL,
	"summary" text NOT NULL,
	"extracted_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	"fresh_at" bigint NOT NULL,
	"embedding" vector(768),
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"topic" text NOT NULL,
	"description" text,
	"approved_sources" text[] DEFAULT '{}' NOT NULL,
	"approved_agents" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"poll_interval_sec" integer DEFAULT 21600 NOT NULL,
	"max_findings_per_run" integer DEFAULT 10 NOT NULL,
	"last_run_at" bigint,
	"last_success_at" bigint,
	"last_error" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "retrieval_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"query" text NOT NULL,
	"query_embedding" vector(768),
	"memory_ids_returned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scores" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retrieval_type" text DEFAULT 'hybrid' NOT NULL,
	"latency_ms" integer,
	"was_used" boolean DEFAULT false NOT NULL,
	"used_by_run_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revenue_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"amount_usd" real NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"customer_ref" text,
	"workflow_run_id" text,
	"occurred_at" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risks" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text,
	"title" text NOT NULL,
	"description" text,
	"severity" "risk_severity" DEFAULT 'medium' NOT NULL,
	"probability" real DEFAULT 0.5 NOT NULL,
	"impact" real DEFAULT 0.5 NOT NULL,
	"risk_score" real DEFAULT 0.25 NOT NULL,
	"category" text DEFAULT 'operational' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"mitigations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detected_at" bigint NOT NULL,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roadmap_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"recommendation_id" text,
	"phase" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"impact" integer NOT NULL,
	"risk" integer NOT NULL,
	"priority_score" integer NOT NULL,
	"assigned_agent" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"predecessors" text[] DEFAULT '{}' NOT NULL,
	"mission_alignment" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rollback_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"snapshot_id" text,
	"trace_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rollback_results" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"item_id" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"restored_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runaway_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"job_type" text NOT NULL,
	"endpoint_id" text,
	"provider_id" text,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"stopped_at" bigint,
	"detected_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"region" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"capacity" integer DEFAULT 1 NOT NULL,
	"active_load" integer DEFAULT 0 NOT NULL,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"endpoint" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_heartbeat_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_safety_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"autonomous_deploy_allowed" boolean DEFAULT false NOT NULL,
	"self_edit_loops_allowed" boolean DEFAULT false NOT NULL,
	"autonomous_deps_upgrades_allowed" boolean DEFAULT false NOT NULL,
	"destructive_migrations_allowed" boolean DEFAULT false NOT NULL,
	"internet_learning_swarm_allowed" boolean DEFAULT false NOT NULL,
	"approval_gated_patches_enabled" boolean DEFAULT true NOT NULL,
	"failure_learning_enabled" boolean DEFAULT true NOT NULL,
	"observability_enabled" boolean DEFAULT true NOT NULL,
	"war_room_enabled" boolean DEFAULT true NOT NULL,
	"cron_scans_enabled" boolean DEFAULT true NOT NULL,
	"incident_alerts_enabled" boolean DEFAULT true NOT NULL,
	"tonight_mode_active" boolean DEFAULT true NOT NULL,
	"set_by" text,
	"notes" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mode" text DEFAULT 'local' NOT NULL,
	"allow_local_gpu" boolean DEFAULT true NOT NULL,
	"allow_local_browser" boolean DEFAULT true NOT NULL,
	"preferred_providers" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sandbox_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"lease_owner" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sandbox_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text,
	"run_id" text,
	"lease_owner" text NOT NULL,
	"lease_expires_at" bigint NOT NULL,
	"last_heartbeat" bigint NOT NULL,
	"command" text NOT NULL,
	"args" text[] DEFAULT '{}' NOT NULL,
	"working_dir" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"timeout_ms" integer DEFAULT 120000 NOT NULL,
	"started_at" bigint NOT NULL,
	"completed_at" bigint,
	"stdout_redacted" text DEFAULT '' NOT NULL,
	"stderr_redacted" text DEFAULT '' NOT NULL,
	"secrets_redacted" integer DEFAULT 0 NOT NULL,
	"violation_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_views" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"operator_id" text,
	"name" text NOT NULL,
	"template" text NOT NULL,
	"focus_system" text,
	"camera_position" jsonb,
	"lod" text DEFAULT 'systems' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scaling_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"before" integer,
	"after" integer,
	"reason" text NOT NULL,
	"approved_by" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenario_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"observed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"matched_case" text,
	"delta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scenarios" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"best_case" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"likely_case" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"worst_case" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"mitigation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"workflow_id" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" bigint,
	"next_run_at" bigint,
	"last_run_status" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets_vault" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text,
	"value_ciphertext" text NOT NULL,
	"value_redacted" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"rotated_at" bigint,
	"last_accessed_at" bigint,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"description" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" bigint,
	"findings_produced" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"user_id" text,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"resource" text,
	"action" text,
	"outcome" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"immutable" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"agent_id" text NOT NULL,
	"agent_role" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected_resource" text,
	"recommended_action" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"blocks_launch" boolean DEFAULT false NOT NULL,
	"mitigation_task_id" text,
	"reviewed_by" text,
	"reviewed_at" bigint,
	"resolution_note" text,
	"detected_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "self_heal_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"applied" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"created_at" bigint NOT NULL,
	"applied_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "setup_state" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"first_run_at" bigint NOT NULL,
	"first_provider_at" bigint,
	"first_chat_at" bigint,
	"first_action_at" bigint,
	"first_horizon_at" bigint,
	"first_proposal_at" bigint,
	"first_revenue_at" bigint,
	"completed_onboarding" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_library" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"license" text,
	"source_repo" text,
	"source_path" text NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"file_hash" text NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" bigint,
	"imported_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"purpose" text NOT NULL,
	"category" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_agent_type" text,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"inputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outputs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"safety_rules" text[] DEFAULT '{}' NOT NULL,
	"rollback_behavior" text,
	"verification_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" bigint,
	"avg_duration_ms" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "snapshot_items" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"item_type" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_state" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"trace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "social_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_ref" text NOT NULL,
	"body" text NOT NULL,
	"asset_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" bigint,
	"posted_at" bigint,
	"external_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"approval_id" text,
	"engagement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"spam_score" real,
	"block_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "speech_provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"endpoint" text,
	"key_ref" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"preferred_voice" text,
	"preferred_locale" text DEFAULT 'en-US' NOT NULL,
	"max_cost_per_min_usd" real DEFAULT 0.5 NOT NULL,
	"max_latency_ms" integer DEFAULT 1500 NOT NULL,
	"supports_streaming" boolean DEFAULT true NOT NULL,
	"supports_interruption" boolean DEFAULT false NOT NULL,
	"last_health_at" bigint,
	"health_score" real DEFAULT 1 NOT NULL,
	"last_latency_ms" integer,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stability_streaks" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"consecutive_stable" integer DEFAULT 0 NOT NULL,
	"last_updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"changed_at" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "step_runs" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"output" jsonb,
	"error" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"rollback" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategic_goals" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text,
	"parent_goal_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" "goal_status" DEFAULT 'draft' NOT NULL,
	"horizon" text DEFAULT 'quarter' NOT NULL,
	"target_date" bigint,
	"progress" real DEFAULT 0 NOT NULL,
	"key_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"owners" text[] DEFAULT '{}' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"completed_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategic_horizons" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"horizon" text NOT NULL,
	"title" text NOT NULL,
	"objectives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_at" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"plan_id" text NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_start" bigint,
	"current_period_end" bigint,
	"trial_ends_at" bigint,
	"canceled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "successful_fixes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"failure_signature" text NOT NULL,
	"fix_description" text NOT NULL,
	"target_ref" text NOT NULL,
	"agent_id" text,
	"verification_evidence_ids" text[] DEFAULT '{}' NOT NULL,
	"patch_record_ids" text[] DEFAULT '{}' NOT NULL,
	"success_count" integer DEFAULT 1 NOT NULL,
	"first_applied_at" bigint NOT NULL,
	"last_applied_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"step_type" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"duration_ms" integer,
	"output" jsonb,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telemetry_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"surface" text,
	"outcome" text,
	"duration_ms" integer,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_stretch_metrics" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"total_calls" bigint DEFAULT 0 NOT NULL,
	"cache_hits" bigint DEFAULT 0 NOT NULL,
	"baseline_tokens_total" bigint DEFAULT 0 NOT NULL,
	"stretched_tokens_total" bigint DEFAULT 0 NOT NULL,
	"saved_tokens_total" bigint DEFAULT 0 NOT NULL,
	"last_call_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trend_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"niche" text NOT NULL,
	"signal" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captured_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_scores" (
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"score" real DEFAULT 0.8 NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "trust_scores_workspace_id_subject_type_subject_id_pk" PRIMARY KEY("workspace_id","subject_type","subject_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_meters" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"meter_key" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_provider_creds" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"api_key_encrypted" text,
	"api_key_iv" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_validated_at" bigint,
	"validation_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verification_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"run_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"command" text NOT NULL,
	"args" text[] DEFAULT '{}' NOT NULL,
	"exit_code" integer NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"passed" boolean NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"files_changed" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_ambient_briefings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"source_event_id" text,
	"delivered_at" bigint,
	"acked_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_dry_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"command" text NOT NULL,
	"intent_kind" text NOT NULL,
	"intent_target" text,
	"verdict" text NOT NULL,
	"risk" text NOT NULL,
	"risk_score" real DEFAULT 0 NOT NULL,
	"estimated_cost_usd" real DEFAULT 0 NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"planned_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"browser_preview" jsonb,
	"affected_systems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rollback_available" boolean DEFAULT false NOT NULL,
	"rollback_strategy" text,
	"spoken_preview" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_via_spoken" boolean DEFAULT false NOT NULL,
	"approved_via_ui" boolean DEFAULT false NOT NULL,
	"approved_at" bigint,
	"executed_at" bigint,
	"execute_result" jsonb,
	"rejected_reason" text,
	"execute_hook" jsonb,
	"budget_decision" jsonb,
	"browser_action_plan" jsonb,
	"executed_via" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"text" text,
	"provider" text,
	"latency_ms" integer,
	"cost_usd" real,
	"meta" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"ref_audio_path" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"consent_attested" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"duration_seconds" real,
	"sample_rate" integer,
	"notes" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_quality_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text,
	"naturalness" integer,
	"speed" integer,
	"clarity" integer,
	"tone" integer,
	"usefulness" integer,
	"comment" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_session_context" (
	"session_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"current_node" text,
	"current_template" text,
	"current_lod" text,
	"active_mission" text,
	"selected_system" text,
	"last_plan" jsonb,
	"pending_plan" jsonb,
	"current_risk" text DEFAULT 'low' NOT NULL,
	"current_ui_mode" text,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"expected_next" jsonb,
	"muted_until" bigint,
	"voice_locked" boolean DEFAULT false NOT NULL,
	"pending_dry_run_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"mode" text NOT NULL,
	"preset" text DEFAULT 'calm_operator' NOT NULL,
	"selected_provider" text NOT NULL,
	"fallback_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"first_audio_ms" integer,
	"avg_latency_ms" integer,
	"total_cost_usd" real DEFAULT 0 NOT NULL,
	"failover_count" integer DEFAULT 0 NOT NULL,
	"blocked_commands" integer DEFAULT 0 NOT NULL,
	"transcript_retained" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_shortcuts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"phrase" text NOT NULL,
	"expansion" text NOT NULL,
	"description" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_skill_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"kind" text NOT NULL,
	"phrase" text,
	"intent_kind" text,
	"from_intent" text,
	"to_intent" text,
	"confidence" real,
	"node_id" text,
	"meta" jsonb,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"run_id" text,
	"error" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text NOT NULL,
	"secret_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"target_url" text,
	"workflow_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"last_called_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_concurrency" (
	"workspace_id" text NOT NULL,
	"queue_name" text NOT NULL,
	"factor" real DEFAULT 1 NOT NULL,
	"set_by" text NOT NULL,
	"reason" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "worker_concurrency_workspace_id_queue_name_pk" PRIMARY KEY("workspace_id","queue_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"worker_name" text NOT NULL,
	"worker_type" text DEFAULT 'cpu' NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"endpoint_url" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"max_concurrent" integer DEFAULT 1 NOT NULL,
	"active_leases" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" bigint,
	"registered_at" bigint NOT NULL,
	"stale_threshold_ms" integer DEFAULT 60000 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"trace_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"worker_name" text NOT NULL,
	"queue_name" text NOT NULL,
	"event" text NOT NULL,
	"heap_used_mb" real,
	"rss_mem_mb" real,
	"active_jobs" integer,
	"processed_jobs" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_definitions" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retry_policy" jsonb NOT NULL,
	"timeout" integer DEFAULT 300000 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"workflow_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" "workflow_status" DEFAULT 'pending' NOT NULL,
	"triggered_by" text NOT NULL,
	"triggered_at" bigint NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"failed_at" bigint,
	"error_message" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"parent_run_id" text,
	"checkpoint_at" bigint,
	"checkpoint_state" jsonb,
	"trace_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_traces" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"status" text NOT NULL,
	"triggered_by" text NOT NULL,
	"started_at" bigint,
	"completed_at" bigint,
	"failed_at" bigint,
	"duration_ms" integer,
	"step_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_voice_prefs" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"preferred_provider" text,
	"preferred_preset" text,
	"preferred_locale" text DEFAULT 'en-US' NOT NULL,
	"transcript_retained" boolean DEFAULT true NOT NULL,
	"auto_confirm_low_risk" boolean DEFAULT false NOT NULL,
	"barge_in_enabled" boolean DEFAULT true NOT NULL,
	"quality_weight" real DEFAULT 0.15 NOT NULL,
	"wake_phrases" jsonb DEFAULT '["hey novan","novan"]'::jsonb NOT NULL,
	"wake_enabled" boolean DEFAULT false NOT NULL,
	"hands_free_enabled" boolean DEFAULT false NOT NULL,
	"hands_free_allowed_intents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ambient_alerts_enabled" boolean DEFAULT true NOT NULL,
	"ambient_severity_floor" text DEFAULT 'critical' NOT NULL,
	"push_to_talk_default" boolean DEFAULT true NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" text PRIMARY KEY DEFAULT 'gen_random_uuid()' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"owner_id" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "briefing_items" ADD CONSTRAINT "briefing_items_briefing_id_briefings_id_fk" FOREIGN KEY ("briefing_id") REFERENCES "public"."briefings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "browser_actions" ADD CONSTRAINT "browser_actions_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "businesses" ADD CONSTRAINT "businesses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "insights" ADD CONSTRAINT "insights_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memories" ADD CONSTRAINT "memories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "risks" ADD CONSTRAINT "risks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "risks" ADD CONSTRAINT "risks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rollback_results" ADD CONSTRAINT "rollback_results_request_id_rollback_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."rollback_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rollback_results" ADD CONSTRAINT "rollback_results_item_id_snapshot_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."snapshot_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "snapshot_items" ADD CONSTRAINT "snapshot_items_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategic_goals" ADD CONSTRAINT "strategic_goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategic_goals" ADD CONSTRAINT "strategic_goals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ac_unique" ON "account_credentials" USING btree ("workspace_id","platform","account_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ac_workspace_idx" ON "account_credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ac_platform_idx" ON "account_credentials" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_workspace_idx" ON "actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_status_idx" ON "actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_type_idx" ON "actions" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_created_idx" ON "actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aa_workspace_idx" ON "agent_assignments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aa_agent_idx" ON "agent_assignments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aa_task_idx" ON "agent_assignments" USING btree ("task_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aa_status_idx" ON "agent_assignments" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aa_priority_idx" ON "agent_assignments" USING btree ("priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agentdef_ws_slug_uniq" ON "agent_definitions" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agentdef_department_idx" ON "agent_definitions" USING btree ("workspace_id","department");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_ws_idx" ON "agent_delegations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_def_idx" ON "agent_delegations" USING btree ("definition_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_created_idx" ON "agent_delegations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_status_idx" ON "agent_delegations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "areg_workspace_idx" ON "agent_registrations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "areg_status_idx" ON "agent_registrations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "areg_heartbeat_idx" ON "agent_registrations" USING btree ("last_heartbeat");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_workspace_idx" ON "agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_status_idx" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "arc_key_idx" ON "ai_response_cache" USING btree ("workspace_id","cache_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arc_expires_idx" ON "ai_response_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_workspace_idx" ON "ai_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_timestamp_idx" ON "ai_usage" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_trace_idx" ON "ai_usage" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_workflow_idx" ON "ai_usage" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "as_workspace_idx" ON "anomaly_signals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "as_kind_idx" ON "anomaly_signals" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "as_severity_idx" ON "anomaly_signals" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "as_created_idx" ON "anomaly_signals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_workspace_idx" ON "api_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "at_trace_idx" ON "approval_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "at_approval_idx" ON "approval_traces" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "at_workspace_idx" ON "approval_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_workspace_idx" ON "approvals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_expires_idx" ON "approvals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "al_workspace_idx" ON "archive_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "al_created_idx" ON "archive_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asm_workspace_idx" ON "assumptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asm_status_idx" ON "assumptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asm_category_idx" ON "assumptions" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asm_last_verified_idx" ON "assumptions" USING btree ("last_verified_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ae_workspace_idx" ON "audit_exports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ae_status_idx" ON "audit_exports" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_run_idx" ON "audit_findings" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_workspace_idx" ON "audit_findings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_category_idx" ON "audit_findings" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_severity_idx" ON "audit_findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "af_file_idx" ON "audit_findings" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar2_workspace_idx" ON "audit_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar2_status_idx" ON "audit_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar2_created_idx" ON "audit_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aj_run_idx" ON "autonomous_jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aj_workspace_idx" ON "autonomous_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aj_status_idx" ON "autonomous_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aj_phase_idx" ON "autonomous_jobs" USING btree ("phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "aj_created_idx" ON "autonomous_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_workspace_idx" ON "autonomous_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_status_idx" ON "autonomous_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ar_created_idx" ON "autonomous_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bi_briefing_idx" ON "briefing_items" USING btree ("briefing_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bi_workspace_idx" ON "briefing_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bi_section_idx" ON "briefing_items" USING btree ("section");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bi_converted_idx" ON "briefing_items" USING btree ("converted");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefing_workspace_idx" ON "briefings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefing_status_idx" ON "briefings" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "briefing_created_idx" ON "briefings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bact_session_idx" ON "browser_actions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bact_workspace_idx" ON "browser_actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bsess_workspace_idx" ON "browser_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bsess_job_idx" ON "browser_sessions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bsess_started_idx" ON "browser_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ba_workspace_idx" ON "budget_alerts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ba_fired_idx" ON "budget_alerts" USING btree ("fired_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ba_dismissed_idx" ON "budget_alerts" USING btree ("dismissed");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bc_scope_idx" ON "budget_caps" USING btree ("workspace_id","scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bc_workspace_idx" ON "budget_caps" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bc_scope_type_idx" ON "budget_caps" USING btree ("scope_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_run_idx" ON "build_tasks" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_workspace_idx" ON "build_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_status_idx" ON "build_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_priority_idx" ON "build_tasks" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_severity_idx" ON "build_tasks" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bt_category_idx" ON "build_tasks" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_sys_ws_idx" ON "business_systems" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_sys_business_idx" ON "business_systems" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_sys_kind_idx" ON "business_systems" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_sys_parent_idx" ON "business_systems" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_workspace_idx" ON "businesses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ce_workspace_idx" ON "chain_embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca2_message_idx" ON "chat_actions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca2_workspace_idx" ON "chat_actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca2_status_idx" ON "chat_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patches_workspace_idx" ON "code_patches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patches_proposal_idx" ON "code_patches" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patches_status_idx" ON "code_patches" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cp_workspace_idx" ON "code_proposals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cp_status_idx" ON "code_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cp_capability_idx" ON "code_proposals" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cp_shipped_idx" ON "code_proposals" USING btree ("shipped_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cs_committed_idx" ON "code_state_snapshots" USING btree ("committed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cev_session_idx" ON "commerce_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cev_workspace_idx" ON "commerce_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cev_occurred_idx" ON "commerce_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csess_workspace_idx" ON "commerce_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csess_status_idx" ON "commerce_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "co_verdict_idx" ON "commit_outcomes" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca_workspace_idx" ON "communication_audit" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca_source_idx" ON "communication_audit" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ca_created_idx" ON "communication_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cl_workspace_idx" ON "compressed_lessons" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cl_kind_idx" ON "compressed_lessons" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cl_archived_idx" ON "compressed_lessons" USING btree ("archived_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_acct_workspace_idx" ON "connector_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_acct_connector_idx" ON "connector_accounts" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_acct_status_idx" ON "connector_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_act_workspace_idx" ON "connector_actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_act_account_idx" ON "connector_actions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_act_phase_idx" ON "connector_actions" USING btree ("phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_act_approval_idx" ON "connector_actions" USING btree ("requires_approval","phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_act_created_idx" ON "connector_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_rl_workspace_idx" ON "connector_rate_limits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conn_rl_account_idx" ON "connector_rate_limits" USING btree ("account_id","action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_category_idx" ON "connectors" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_implemented_idx" ON "connectors" USING btree ("implemented");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_workspace_idx" ON "conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_updated_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_branch_root_idx" ON "conversations" USING btree ("branch_root_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_forked_from_idx" ON "conversations" USING btree ("forked_from_conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dlq_workspace_idx" ON "dead_letter_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dlq_queue_idx" ON "dead_letter_jobs" USING btree ("queue_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dlq_dead_lettered_at_idx" ON "dead_letter_jobs" USING btree ("dead_lettered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dc_workspace_idx" ON "design_concepts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dc_status_idx" ON "design_concepts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drift_workspace_idx" ON "drift_warnings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drift_status_idx" ON "drift_warnings" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drift_kind_idx" ON "drift_warnings" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dml_workspace_idx" ON "duplicate_merge_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dml_status_idx" ON "duplicate_merge_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dml_entity_idx" ON "duplicate_merge_log" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eul_workspace_idx" ON "endpoint_usage_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eul_endpoint_idx" ON "endpoint_usage_logs" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eul_created_idx" ON "endpoint_usage_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eb_workspace_idx" ON "ethical_blocks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eb_category_idx" ON "ethical_blocks" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eb_blocked_idx" ON "ethical_blocks" USING btree ("blocked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "et_trace_idx" ON "event_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "et_workspace_idx" ON "event_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "et_created_idx" ON "event_traces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_workspace_type_idx" ON "events" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_trace_idx" ON "events" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_created_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eg_workspace_idx" ON "execution_guards" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eg_execution_idx" ON "execution_guards" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eg_decision_idx" ON "execution_guards" USING btree ("decision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eg_created_idx" ON "execution_guards" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_workspace_idx" ON "execution_leases" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_worker_idx" ON "execution_leases" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_job_idx" ON "execution_leases" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_status_idx" ON "execution_leases" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_workflow_idx" ON "execution_leases" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "el_expires_idx" ON "execution_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exlock_workspace_idx" ON "execution_locks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exlock_resource_idx" ON "execution_locks" USING btree ("lock_kind","resource_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exlock_holder_idx" ON "execution_locks" USING btree ("holder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exlock_expires_idx" ON "execution_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erl_workspace_idx" ON "executive_review_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erl_cycle_idx" ON "executive_review_log" USING btree ("cycle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "erl_created_idx" ON "executive_review_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ef_workspace_idx" ON "external_feeds" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ef_enabled_idx" ON "external_feeds" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ef_polled_idx" ON "external_feeds" USING btree ("last_polled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ek_workspace_idx" ON "external_knowledge" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ek_url_idx" ON "external_knowledge" USING btree ("url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ek_source_idx" ON "external_knowledge" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ek_fetched_idx" ON "external_knowledge" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ek_expires_idx" ON "external_knowledge" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fl_run_idx" ON "failure_lineages" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fl_trace_idx" ON "failure_lineages" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fl_workspace_idx" ON "failure_lineages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_workspace_idx" ON "failure_memory" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_signature_idx" ON "failure_memory" USING btree ("signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_target_idx" ON "failure_memory" USING btree ("target_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_type_idx" ON "failure_memory" USING btree ("failure_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_agent_idx" ON "failure_memory" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fm_count_idx" ON "failure_memory" USING btree ("occurrence_count");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_workspace_idx" ON "feedback_reports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_status_idx" ON "feedback_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fb_created_idx" ON "feedback_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_workspace_idx" ON "ideas" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_status_idx" ON "ideas" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_category_idx" ON "ideas" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_fingerprint_idx" ON "ideas" USING btree ("workspace_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_source_idx" ON "ideas" USING btree ("source_type","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_created_idx" ON "ideas" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_workspace_idx" ON "image_generations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_status_idx" ON "image_generations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_provider_idx" ON "image_generations" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_created_idx" ON "image_generations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_favorite_idx" ON "image_generations" USING btree ("is_favorite");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_batch_idx" ON "image_generations" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_trace_idx" ON "image_generations" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ig_workflow_idx" ON "image_generations" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iqr_workspace_idx" ON "image_quality_reviews" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iqr_generation_idx" ON "image_quality_reviews" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iqr_verdict_idx" ON "image_quality_reviews" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iqr_created_idx" ON "image_quality_reviews" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_workspace_idx" ON "inbound_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_channel_idx" ON "inbound_messages" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ib_received_idx" ON "inbound_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inct_incident_idx" ON "incident_timeline" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inct_workspace_idx" ON "incident_timeline" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inct_created_idx" ON "incident_timeline" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_workspace_idx" ON "incidents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_status_idx" ON "incidents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_severity_idx" ON "incidents" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_type_idx" ON "incidents" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_detected_idx" ON "incidents" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_workspace_idx" ON "insights" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_category_idx" ON "insights" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insight_created_idx" ON "insights" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_workspace_idx" ON "issues" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_status_idx" ON "issues" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_severity_idx" ON "issues" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_source_idx" ON "issues" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_fingerprint_idx" ON "issues" USING btree ("workspace_id","fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_detected_idx" ON "issues" USING btree ("detected_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ks_workspace_type_idx" ON "kill_switches" USING btree ("workspace_id","switch_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ks_workspace_idx" ON "kill_switches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_workspace_idx" ON "launch_audits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_score_idx" ON "launch_audits" USING btree ("readiness_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "la_created_idx" ON "launch_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ll_workspace_idx" ON "launch_locks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ll_locked_idx" ON "launch_locks" USING btree ("locked");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lf_workspace_idx" ON "learning_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lf_rec_idx" ON "learning_feedback" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lf_action_idx" ON "learning_feedback" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "li_workspace_idx" ON "learning_insights" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "li_category_idx" ON "learning_insights" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "li_status_idx" ON "learning_insights" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "li_confidence_idx" ON "learning_insights" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_workspace_idx" ON "learning_patterns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_type_idx" ON "learning_patterns" USING btree ("pattern_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_status_idx" ON "learning_patterns" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lp_confidence_idx" ON "learning_patterns" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lsc_workspace_idx" ON "learning_scores" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lsc_entity_idx" ON "learning_scores" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lsc_type_idx" ON "learning_scores" USING btree ("score_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ls_workspace_idx" ON "learning_signals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ls_source_idx" ON "learning_signals" USING btree ("source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ls_status_idx" ON "learning_signals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ls_created_idx" ON "learning_signals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_workspace_idx" ON "memories" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_type_idx" ON "memories" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_tags_idx" ON "memories" USING btree ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_created_idx" ON "memories" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mc_workspace_idx" ON "memory_clusters" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "me_workspace_idx" ON "memory_embeddings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "me_memory_idx" ON "memory_embeddings" USING btree ("memory_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "me_stale_idx" ON "memory_embeddings" USING btree ("is_stale");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_conv_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_workspace_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_created_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "msg_superseded_idx" ON "messages" USING btree ("superseded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mqs_workspace_idx" ON "model_quality_scores" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mqs_provider_idx" ON "model_quality_scores" USING btree ("provider","model");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mqs_task_idx" ON "model_quality_scores" USING btree ("task_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_workspace_idx" ON "notifications" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_read_idx" ON "notifications" USING btree ("read");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ols_workspace_idx" ON "operator_load_snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ols_created_idx" ON "operator_load_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "op_presence_idx" ON "operator_presence" USING btree ("workspace_id","operator_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_workspace_idx" ON "opportunities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_status_idx" ON "opportunities" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_priority_idx" ON "opportunities" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_type_idx" ON "opportunities" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunity_score_idx" ON "opportunities" USING btree ("score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_workspace_idx" ON "optimization_recommendations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_category_idx" ON "optimization_recommendations" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_status_idx" ON "optimization_recommendations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_priority_idx" ON "optimization_recommendations" USING btree ("priority_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ol_workspace_idx" ON "override_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ol_action_idx" ON "override_log" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ol_created_idx" ON "override_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_task_idx" ON "patch_approvals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_run_idx" ON "patch_approvals" USING btree ("audit_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_workspace_idx" ON "patch_approvals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_status_idx" ON "patch_approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_risk_idx" ON "patch_approvals" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pa_created_idx" ON "patch_approvals" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_job_idx" ON "patch_records" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_run_idx" ON "patch_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_workspace_idx" ON "patch_records" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_status_idx" ON "patch_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_file_idx" ON "patch_records" USING btree ("file_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "perm_user_workspace_idx" ON "permissions" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "perm_role_idx" ON "permissions" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_ws_idx" ON "platform_smoke_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "smoke_ran_idx" ON "platform_smoke_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pl_workspace_idx" ON "pod_listings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pl_platform_idx" ON "pod_listings" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pl_status_idx" ON "pod_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pt_trace_idx" ON "policy_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pt_workspace_idx" ON "policy_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pt_verdict_idx" ON "policy_traces" USING btree ("verdict");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promptt_workspace_idx" ON "prompt_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promptt_category_idx" ON "prompt_templates" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pb_workspace_idx" ON "provider_budgets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_workspace_idx" ON "provider_configs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_provider_idx" ON "provider_configs" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pc_enabled_idx" ON "provider_configs" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pf_workspace_idx" ON "provider_failures" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pf_provider_idx" ON "provider_failures" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pf_created_idx" ON "provider_failures" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pf_error_idx" ON "provider_failures" USING btree ("error_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phl_workspace_idx" ON "provider_health_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phl_provider_idx" ON "provider_health_log" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "phl_checked_idx" ON "provider_health_log" USING btree ("checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pq_workspace_provider_idx" ON "provider_quarantine" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pq_workspace_idx" ON "provider_quarantine" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pq_released_idx" ON "provider_quarantine" USING btree ("released_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ps_workspace_provider_idx" ON "provider_scores" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ps_workspace_idx" ON "provider_scores" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ps_composite_idx" ON "provider_scores" USING btree ("composite_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ps_circuit_idx" ON "provider_scores" USING btree ("circuit_state");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "qp_workspace_queue_idx" ON "queue_pauses" USING btree ("workspace_id","queue_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qp_workspace_idx" ON "queue_pauses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qp_paused_idx" ON "queue_pauses" USING btree ("paused");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qt_trace_idx" ON "queue_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qt_queue_idx" ON "queue_traces" USING btree ("queue_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "qt_job_idx" ON "queue_traces" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_workspace_idx" ON "reasoning_chains" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_kind_idx" ON "reasoning_chains" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_subject_idx" ON "reasoning_chains" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_outcome_idx" ON "reasoning_chains" USING btree ("outcome_known");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recfeed_workspace_idx" ON "recommendation_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recfeed_chain_idx" ON "recommendation_feedback" USING btree ("chain_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recfeed_action_idx" ON "recommendation_feedback" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ro_workspace_idx" ON "recommendation_outcomes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ro_rec_idx" ON "recommendation_outcomes" USING btree ("recommendation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rcp_run_idx" ON "recovery_checkpoints" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rcp_workspace_idx" ON "recovery_checkpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_run_idx" ON "recovery_log" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_workspace_idx" ON "recovery_log" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "re_workspace_idx" ON "remote_endpoints" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "re_enabled_idx" ON "remote_endpoints" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "re_health_idx" ON "remote_endpoints" USING btree ("health_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "re_priority_idx" ON "remote_endpoints" USING btree ("priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpd_workspace_idx" ON "replay_divergences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpd_replay_run_idx" ON "replay_divergences" USING btree ("replay_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpd_created_idx" ON "replay_divergences" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpr_workspace_idx" ON "replay_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpr_source_run_idx" ON "replay_runs" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpr_status_idx" ON "replay_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpr_created_idx" ON "replay_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rss_run_idx" ON "repo_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rss_workspace_idx" ON "repo_snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_workspace_idx" ON "research_findings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_topic_idx" ON "research_findings" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_agent_idx" ON "research_findings" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rf_hash_idx" ON "research_findings" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rf_fresh_idx" ON "research_findings" USING btree ("fresh_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rtopic_workspace_idx" ON "research_topics" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rtopic_status_idx" ON "research_topics" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rtopic_last_run_idx" ON "research_topics" USING btree ("last_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_workspace_idx" ON "retrieval_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_used_idx" ON "retrieval_logs" USING btree ("was_used");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rl_created_idx" ON "retrieval_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rev_workspace_idx" ON "revenue_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rev_occurred_idx" ON "revenue_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rev_workflow_idx" ON "revenue_events" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_workspace_idx" ON "risks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_severity_idx" ON "risks" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "risk_score_idx" ON "risks" USING btree ("risk_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_workspace_idx" ON "roadmap_tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_phase_idx" ON "roadmap_tasks" USING btree ("phase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_status_idx" ON "roadmap_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rt_priority_idx" ON "roadmap_tasks" USING btree ("priority_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rr_run_idx" ON "rollback_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rr_workspace_idx" ON "rollback_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rr_status_idx" ON "rollback_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rb_request_idx" ON "rollback_results" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rb_workspace_idx" ON "rollback_results" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rj_workspace_idx" ON "runaway_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rj_job_id_idx" ON "runaway_jobs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rj_detected_idx" ON "runaway_jobs" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rj_stopped_idx" ON "runaway_jobs" USING btree ("stopped");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rn_workspace_idx" ON "runtime_nodes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rn_status_idx" ON "runtime_nodes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rn_region_idx" ON "runtime_nodes" USING btree ("region");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rsf_workspace_idx" ON "runtime_safety_flags" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rsf_tonight_idx" ON "runtime_safety_flags" USING btree ("tonight_mode_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rs_workspace_idx" ON "runtime_settings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rs_mode_idx" ON "runtime_settings" USING btree ("mode");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sev_session_idx" ON "sandbox_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sev_workspace_idx" ON "sandbox_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sev_type_idx" ON "sandbox_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sev_created_idx" ON "sandbox_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ss_workspace_idx" ON "sandbox_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ss_job_idx" ON "sandbox_sessions" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ss_status_idx" ON "sandbox_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ss_lease_owner_idx" ON "sandbox_sessions" USING btree ("lease_owner");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ss_started_idx" ON "sandbox_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savedview_workspace_idx" ON "saved_views" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "savedview_updated_idx" ON "saved_views" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "se_workspace_idx" ON "scaling_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "se_kind_idx" ON "scaling_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "se_created_idx" ON "scaling_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "so_scenario_idx" ON "scenario_outcomes" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "so_workspace_idx" ON "scenario_outcomes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sc_workspace_idx" ON "scenarios" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sc_kind_idx" ON "scenarios" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sc_created_idx" ON "scenarios" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_triggers_ws_idx" ON "scheduled_triggers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_triggers_enabled_idx" ON "scheduled_triggers" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sv_workspace_idx" ON "secrets_vault" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sv_name_idx" ON "secrets_vault" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sv_provider_idx" ON "secrets_vault" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seca_role_idx" ON "security_agents" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seca_active_idx" ON "security_agents" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sa_workspace_idx" ON "security_audits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sa_user_idx" ON "security_audits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sa_event_idx" ON "security_audits" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sa_severity_idx" ON "security_audits" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sa_created_idx" ON "security_audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_workspace_idx" ON "security_findings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_agent_idx" ON "security_findings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_severity_idx" ON "security_findings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_status_idx" ON "security_findings" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_blocks_idx" ON "security_findings" USING btree ("blocks_launch");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secf_detected_idx" ON "security_findings" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sha_workspace_idx" ON "self_heal_actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sha_kind_idx" ON "self_heal_actions" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sha_created_idx" ON "self_heal_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sklib_workspace_idx" ON "skill_library" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sklib_category_idx" ON "skill_library" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sklib_use_idx" ON "skill_library" USING btree ("use_count");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sklib_hash_idx" ON "skill_library" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_workspace_idx" ON "skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_status_idx" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_category_idx" ON "skills" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skill_slug_idx" ON "skills" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_snapshot_idx" ON "snapshot_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_entity_idx" ON "snapshot_items" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_run_idx" ON "snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_workspace_idx" ON "snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_trace_idx" ON "snapshots" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sp_workspace_idx" ON "social_posts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sp_status_idx" ON "social_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sp_platform_idx" ON "social_posts" USING btree ("platform");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spc_workspace_idx" ON "speech_provider_configs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spc_kind_idx" ON "speech_provider_configs" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sch_workspace_idx" ON "status_changes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sch_entity_idx" ON "status_changes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sch_changed_idx" ON "status_changes" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_run_run_idx" ON "step_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "step_run_status_idx" ON "step_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_workspace_idx" ON "strategic_goals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_status_idx" ON "strategic_goals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_horizon_idx" ON "strategic_goals" USING btree ("horizon");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_workspace_idx" ON "strategic_horizons" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_horizon_idx" ON "strategic_horizons" USING btree ("horizon");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sh_status_idx" ON "strategic_horizons" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_workspace_idx" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sf_workspace_idx" ON "successful_fixes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sf_signature_idx" ON "successful_fixes" USING btree ("failure_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sf_target_idx" ON "successful_fixes" USING btree ("target_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sf_agent_idx" ON "successful_fixes" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tt_trace_idx" ON "task_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tt_run_idx" ON "task_traces" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tt_workspace_idx" ON "task_traces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tel_workspace_idx" ON "telemetry_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tel_category_idx" ON "telemetry_events" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tel_name_idx" ON "telemetry_events" USING btree ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tel_created_idx" ON "telemetry_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_workspace_idx" ON "trend_findings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_niche_idx" ON "trend_findings" USING btree ("niche");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_captured_idx" ON "trend_findings" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ts_workspace_idx" ON "trust_scores" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "um_workspace_period_idx" ON "usage_meters" USING btree ("workspace_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "um_key_idx" ON "usage_meters" USING btree ("meter_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "upc_user_provider_idx" ON "user_provider_creds" USING btree ("workspace_id","user_id","provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upc_workspace_idx" ON "user_provider_creds" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upc_user_idx" ON "user_provider_creds" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ve_job_idx" ON "verification_evidence" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ve_run_idx" ON "verification_evidence" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ve_workspace_idx" ON "verification_evidence" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ve_passed_idx" ON "verification_evidence" USING btree ("passed");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ve_created_idx" ON "verification_evidence" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vab_workspace_idx" ON "voice_ambient_briefings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vab_severity_idx" ON "voice_ambient_briefings" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vab_created_idx" ON "voice_ambient_briefings" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vdr_workspace_idx" ON "voice_dry_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vdr_session_idx" ON "voice_dry_runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vdr_status_idx" ON "voice_dry_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vdr_created_idx" ON "voice_dry_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vev_session_idx" ON "voice_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vev_workspace_idx" ON "voice_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vev_kind_idx" ON "voice_events" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vev_created_idx" ON "voice_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vp_workspace_idx" ON "voice_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vp_active_idx" ON "voice_profiles" USING btree ("workspace_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vqf_workspace_idx" ON "voice_quality_feedback" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vqf_session_idx" ON "voice_quality_feedback" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vqf_provider_idx" ON "voice_quality_feedback" USING btree ("provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vqf_created_idx" ON "voice_quality_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsc_workspace_idx" ON "voice_session_context" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsc_updated_idx" ON "voice_session_context" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vs_workspace_idx" ON "voice_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vs_started_idx" ON "voice_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vs_status_idx" ON "voice_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsc_workspace_phrase_idx" ON "voice_shortcuts" USING btree ("workspace_id","phrase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsc_user_idx" ON "voice_shortcuts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vso_workspace_idx" ON "voice_skill_observations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vso_kind_idx" ON "voice_skill_observations" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vso_phrase_idx" ON "voice_skill_observations" USING btree ("phrase");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vso_intent_idx" ON "voice_skill_observations" USING btree ("intent_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vso_created_idx" ON "voice_skill_observations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wdel_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wdel_workspace_idx" ON "webhook_deliveries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_workspace_idx" ON "webhook_secrets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_channel_idx" ON "webhook_secrets" USING btree ("channel");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_workspace_idx" ON "webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_active_idx" ON "webhooks" USING btree ("active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wr_workspace_idx" ON "worker_registry" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wr_status_idx" ON "worker_registry" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wr_type_idx" ON "worker_registry" USING btree ("worker_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wr_heartbeat_idx" ON "worker_registry" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wort_trace_idx" ON "worker_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wort_worker_idx" ON "worker_traces" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wort_queue_idx" ON "worker_traces" USING btree ("queue_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_def_workspace_idx" ON "workflow_definitions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_def_tags_idx" ON "workflow_definitions" USING btree ("tags");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_workspace_idx" ON "workflow_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_run_triggered_idx" ON "workflow_runs" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wt_trace_idx" ON "workflow_traces" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wt_run_idx" ON "workflow_traces" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wt_workspace_idx" ON "workflow_traces" USING btree ("workspace_id");