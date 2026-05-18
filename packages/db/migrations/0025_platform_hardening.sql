-- 0025_platform_hardening.sql
-- Data retention, notification prefs, setup state, webhook secrets.

CREATE TABLE IF NOT EXISTS "archive_log" (
  "id"                 text PRIMARY KEY,
  "workspace_id"       text NOT NULL,
  "table_name"         text NOT NULL,
  "rows_archived"      integer NOT NULL,
  "archived_through_ts" bigint NOT NULL,
  "elapsed_ms"         integer NOT NULL,
  "created_at"         bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "al_workspace_idx" ON "archive_log" ("workspace_id");
CREATE INDEX IF NOT EXISTS "al_created_idx"   ON "archive_log" ("created_at");

CREATE TABLE IF NOT EXISTS "notification_prefs" (
  "workspace_id"   text NOT NULL,
  "type"           text NOT NULL,           -- notification type or '*' for global
  "severity_floor" text NOT NULL DEFAULT 'normal', -- normal | high | critical
  "muted_until"    bigint,
  "updated_at"     bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "type")
);

CREATE TABLE IF NOT EXISTS "setup_state" (
  "workspace_id"        text PRIMARY KEY,
  "first_run_at"        bigint NOT NULL,
  "first_provider_at"   bigint,
  "first_chat_at"       bigint,
  "first_action_at"     bigint,
  "first_horizon_at"    bigint,
  "first_proposal_at"   bigint,
  "first_revenue_at"    bigint,
  "completed_onboarding" boolean NOT NULL DEFAULT false,
  "updated_at"          bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "webhook_secrets" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "channel"        text NOT NULL,           -- slack | github | custom | etc.
  "secret_hash"    text NOT NULL,           -- SHA-256 of HMAC key
  "active"         boolean NOT NULL DEFAULT true,
  "created_at"     bigint NOT NULL,
  "last_used_at"   bigint
);
CREATE INDEX IF NOT EXISTS "ws_workspace_idx" ON "webhook_secrets" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ws_channel_idx"   ON "webhook_secrets" ("channel");
