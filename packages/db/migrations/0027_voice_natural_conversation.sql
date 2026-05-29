-- 0027_voice_natural_conversation.sql
-- Per-session conversation context + voice quality feedback.

CREATE TABLE IF NOT EXISTS "voice_session_context" (
  "session_id"          text PRIMARY KEY,
  "workspace_id"        text NOT NULL,
  "current_node"        text,                -- last focused brain node id
  "current_template"    text,                -- last brain template
  "current_lod"         text,                -- global | systems | focus
  "active_mission"      text,
  "selected_system"     text,                -- last system referent ("it"/"there")
  "last_plan"           jsonb,               -- last ActionPlan (for "explain that")
  "pending_plan"        jsonb,               -- queued plan awaiting confirmation
  "current_risk"        text NOT NULL DEFAULT 'low',
  "current_ui_mode"     text,                -- which page user is on
  "preferences"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "turn_count"          integer NOT NULL DEFAULT 0,
  "updated_at"          bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vsc_workspace_idx" ON "voice_session_context" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vsc_updated_idx"   ON "voice_session_context" ("updated_at");

CREATE TABLE IF NOT EXISTS "voice_quality_feedback" (
  "id"            text PRIMARY KEY,
  "session_id"    text NOT NULL,
  "workspace_id"  text NOT NULL,
  "provider"      text,
  "naturalness"   integer,                  -- 1..5
  "speed"         integer,
  "clarity"       integer,
  "tone"          integer,
  "usefulness"    integer,
  "comment"       text,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vqf_workspace_idx" ON "voice_quality_feedback" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vqf_session_idx"   ON "voice_quality_feedback" ("session_id");
CREATE INDEX IF NOT EXISTS "vqf_provider_idx"  ON "voice_quality_feedback" ("provider");
CREATE INDEX IF NOT EXISTS "vqf_created_idx"   ON "voice_quality_feedback" ("created_at");
