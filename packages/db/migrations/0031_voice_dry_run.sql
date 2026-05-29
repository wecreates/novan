-- 0031_voice_dry_run.sql
-- Voice dry-run simulator: persist the simulated plan before any execution.

CREATE TABLE IF NOT EXISTS "voice_dry_runs" (
  "id"                  text PRIMARY KEY,
  "workspace_id"        text NOT NULL,
  "user_id"             text,
  "session_id"          text,
  "command"             text NOT NULL,             -- verbatim transcript
  "intent_kind"         text NOT NULL,
  "intent_target"       text,
  "verdict"             text NOT NULL,             -- navigate | execute | confirm | reject
  "risk"                text NOT NULL,             -- low | medium | high
  "risk_score"          real NOT NULL DEFAULT 0,    -- 0..1
  "estimated_cost_usd"  real NOT NULL DEFAULT 0,
  "permissions"         jsonb NOT NULL DEFAULT '[]'::jsonb,
  "planned_steps"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "browser_preview"     jsonb,                     -- null unless browser intent
  "affected_systems"    jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blocked_actions"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rollback_available"  boolean NOT NULL DEFAULT false,
  "rollback_strategy"   text,
  "spoken_preview"      text NOT NULL,
  "status"              text NOT NULL DEFAULT 'pending',   -- pending | approved | executed | rejected | expired
  "approved_via_spoken" boolean NOT NULL DEFAULT false,
  "approved_via_ui"     boolean NOT NULL DEFAULT false,
  "approved_at"         bigint,
  "executed_at"         bigint,
  "execute_result"      jsonb,
  "rejected_reason"     text,
  "created_at"          bigint NOT NULL,
  "expires_at"          bigint NOT NULL            -- pending dry-runs auto-expire after 5 min
);
CREATE INDEX IF NOT EXISTS "vdr_workspace_idx" ON "voice_dry_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vdr_session_idx"   ON "voice_dry_runs" ("session_id");
CREATE INDEX IF NOT EXISTS "vdr_status_idx"    ON "voice_dry_runs" ("status");
CREATE INDEX IF NOT EXISTS "vdr_created_idx"   ON "voice_dry_runs" ("created_at");
