CREATE TABLE IF NOT EXISTS "approved_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"applies_to" text[] DEFAULT '{}' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.7 NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" bigint NOT NULL,
	"superseded_by" text,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"attached_at" bigint NOT NULL,
	"last_synced_at" bigint,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slot" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"score_sum" real DEFAULT 0 NOT NULL,
	"last_score" real,
	"last_used_at" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	"parent_id" text,
	"origin" text DEFAULT 'seed' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_revenue" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"business_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_usd_cents" bigint NOT NULL,
	"source" text,
	"source_ref" text,
	"earnings_month" text NOT NULL,
	"landed_at" bigint,
	"recorded_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cartographer_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"root_path" text NOT NULL,
	"file_count" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"generated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_set_id" text NOT NULL,
	"input" text NOT NULL,
	"expected_behavior" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"known_failure" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"eval_set_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"trigger" text NOT NULL,
	"total_cases" integer NOT NULL,
	"passed_count" integer NOT NULL,
	"avg_grade" real NOT NULL,
	"per_case" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"regressions" text[] DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eval_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_subject" text NOT NULL,
	"baseline_pass_rate" real DEFAULT 0.8 NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"params" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portfolios" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"owner_user_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "portfolios_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approved_patterns_ws_idx" ON "approved_patterns" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bizattach_ws_biz_src_ref_uq" ON "business_attachments" USING btree ("workspace_id","business_id","source","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bizattach_ws_idx" ON "business_attachments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bizattach_biz_idx" ON "business_attachments" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bizattach_src_ref_idx" ON "business_attachments" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_prompt_ws_slot_idx" ON "business_prompts" USING btree ("workspace_id","slot","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "biz_prompt_ws_slot_version_uq" ON "business_prompts" USING btree ("workspace_id","slot","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_rev_biz_month_idx" ON "business_revenue" USING btree ("business_id","earnings_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "biz_rev_ws_idx" ON "business_revenue" USING btree ("workspace_id","recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cartographer_ws_idx" ON "cartographer_snapshots" USING btree ("workspace_id","generated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_cases_set_idx" ON "eval_cases" USING btree ("eval_set_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_runs_set_idx" ON "eval_runs" USING btree ("eval_set_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_runs_workspace_idx" ON "eval_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "eval_sets_ws_name_uq" ON "eval_sets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_sets_workspace_idx" ON "eval_sets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "eval_sets_target_idx" ON "eval_sets" USING btree ("target_subject");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "policy_rules_ws_id_uq" ON "policy_rules" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_rules_workspace_idx" ON "policy_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_rules_enabled_idx" ON "policy_rules" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_workspace_ts_idx" ON "ai_usage" USING btree ("workspace_id","timestamp");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bi_workspace_section_idx" ON "briefing_items" USING btree ("workspace_id","section");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cp_ws_status_idx" ON "code_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_workspace_type_created_idx" ON "events" USING btree ("workspace_id","type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_ws_status_idx" ON "incidents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inc_ws_severity_detected_idx" ON "incidents" USING btree ("workspace_id","severity","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_ws_status_detected_idx" ON "issues" USING btree ("workspace_id","status","detected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rc_ws_outcome_kind_idx" ON "reasoning_chains" USING btree ("workspace_id","outcome_known","kind");