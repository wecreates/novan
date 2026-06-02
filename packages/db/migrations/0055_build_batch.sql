-- 0055 — Build batch (R146.115): War Room agents + YT→shorts + viral scripts
-- + $1M brand launch flow + ChatGPT export import.

CREATE TABLE IF NOT EXISTS "agent_roster" (
  "id"             text PRIMARY KEY NOT NULL,
  "workspace_id"   text NOT NULL,
  "short_name"     text NOT NULL,
  "role"           text NOT NULL,
  "avatar_hue"     integer NOT NULL DEFAULT 180,
  "status"         text NOT NULL DEFAULT 'idle',
  "current_task"   text,
  "last_active_at" bigint,
  "created_at"     bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_roster_ws_short_idx" ON "agent_roster" ("workspace_id", "short_name");
CREATE INDEX IF NOT EXISTS "agent_roster_ws_status_idx" ON "agent_roster" ("workspace_id", "status");

CREATE TABLE IF NOT EXISTS "agent_ops_board" (
  "id"             text PRIMARY KEY NOT NULL,
  "workspace_id"   text NOT NULL,
  "title"          text NOT NULL,
  "owner_agent_id" text,
  "column"         text NOT NULL DEFAULT 'on_deck',
  "due_at"         bigint,
  "notes"          text,
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ops_board_ws_col_idx" ON "agent_ops_board" ("workspace_id", "column", "updated_at");

CREATE TABLE IF NOT EXISTS "shortform_pipelines" (
  "id"              text PRIMARY KEY NOT NULL,
  "workspace_id"    text NOT NULL,
  "source_url"      text NOT NULL,
  "source_title"    text,
  "target_accounts" jsonb,
  "style_profile"   jsonb,
  "enabled"         boolean NOT NULL DEFAULT true,
  "last_checked_at" bigint,
  "created_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sf_pipelines_ws_idx" ON "shortform_pipelines" ("workspace_id", "enabled");

CREATE TABLE IF NOT EXISTS "shortform_clips" (
  "id"                 text PRIMARY KEY NOT NULL,
  "workspace_id"       text NOT NULL,
  "pipeline_id"        text NOT NULL,
  "source_video_url"   text NOT NULL,
  "source_video_title" text,
  "start_sec"          real NOT NULL,
  "end_sec"            real NOT NULL,
  "hook"               text,
  "viral_score"        integer NOT NULL DEFAULT 0,
  "rationale"          text,
  "output_path"        text,
  "output_url"         text,
  "posted_to"          jsonb,
  "status"             text NOT NULL DEFAULT 'queued',
  "error"              text,
  "created_at"         bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sf_clips_ws_status_idx" ON "shortform_clips" ("workspace_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "sf_clips_pipeline_idx" ON "shortform_clips" ("pipeline_id", "created_at");

CREATE TABLE IF NOT EXISTS "viral_style_scripts" (
  "id"            text PRIMARY KEY NOT NULL,
  "workspace_id"  text NOT NULL,
  "source_url"    text NOT NULL,
  "source_title"  text,
  "rank"          integer NOT NULL,
  "title"         text NOT NULL,
  "body"          text NOT NULL,
  "tags"          jsonb,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vss_ws_source_idx" ON "viral_style_scripts" ("workspace_id", "source_url", "rank");

CREATE TABLE IF NOT EXISTS "business_launches" (
  "id"                     text PRIMARY KEY NOT NULL,
  "workspace_id"           text NOT NULL,
  "business_id"            text,
  "idea_seed"              text NOT NULL,
  "problem_statement"      text,
  "validation_notes"       text,
  "brand_name"             text,
  "brand_palette"          jsonb,
  "mockup_urls"            jsonb,
  "landing_page_html"      text,
  "landing_page_url"       text,
  "waitlist_form_url"      text,
  "prelaunch_content_plan" jsonb,
  "current_stage"          text NOT NULL DEFAULT 'validation',
  "stage_history"          jsonb,
  "created_at"             bigint NOT NULL,
  "updated_at"             bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "bl_ws_stage_idx" ON "business_launches" ("workspace_id", "current_stage", "updated_at");

CREATE TABLE IF NOT EXISTS "chatgpt_imports" (
  "id"                  text PRIMARY KEY NOT NULL,
  "workspace_id"        text NOT NULL,
  "source"              text NOT NULL,
  "file_path"           text NOT NULL,
  "conversation_count"  integer NOT NULL DEFAULT 0,
  "ideas_extracted"     integer NOT NULL DEFAULT 0,
  "status"              text NOT NULL DEFAULT 'processing',
  "imported_at"         bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "extracted_business_ideas" (
  "id"                text PRIMARY KEY NOT NULL,
  "workspace_id"      text NOT NULL,
  "import_id"         text,
  "source"            text NOT NULL,
  "title"             text NOT NULL,
  "pitch"             text NOT NULL,
  "problem"           text,
  "audience"          text,
  "revenue_model"     text,
  "feasibility_score" integer NOT NULL DEFAULT 0,
  "conversation_ref"  text,
  "status"            text NOT NULL DEFAULT 'proposed',
  "created_at"        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ebi_ws_score_idx" ON "extracted_business_ideas" ("workspace_id", "feasibility_score", "created_at");
