CREATE TABLE IF NOT EXISTS "scheduled_triggers" (
  "id"              text PRIMARY KEY NOT NULL,
  "workspace_id"    text NOT NULL,
  "name"            text NOT NULL,
  "description"     text,
  "workflow_id"     text NOT NULL,
  "cron_expression" text NOT NULL,
  "timezone"        text NOT NULL DEFAULT 'UTC',
  "enabled"         boolean NOT NULL DEFAULT true,
  "last_run_at"     bigint,
  "next_run_at"     bigint,
  "last_run_status" text,
  "run_count"       integer NOT NULL DEFAULT 0,
  "failure_count"   integer NOT NULL DEFAULT 0,
  "payload"         jsonb,
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "scheduled_triggers_ws_idx"      ON "scheduled_triggers" ("workspace_id");
CREATE INDEX IF NOT EXISTS "scheduled_triggers_enabled_idx" ON "scheduled_triggers" ("enabled", "next_run_at");
