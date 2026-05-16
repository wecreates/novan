-- Migration 0008: Remote Compute Router tables
-- provider_configs, remote_endpoints, provider_health_log, provider_failures, provider_budgets

CREATE TABLE IF NOT EXISTS "provider_configs" (
  "id"                  text PRIMARY KEY,
  "workspace_id"        text NOT NULL,
  "provider_id"         text NOT NULL,
  "label"               text NOT NULL,
  "api_key_encrypted"   text,
  "api_key_iv"          text,
  "enabled"             boolean NOT NULL DEFAULT true,
  "priority"            integer NOT NULL DEFAULT 50,
  "max_cost_per_req_usd" real,
  "notes"               text,
  "created_at"          bigint NOT NULL,
  "updated_at"          bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "pc_workspace_idx" ON "provider_configs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "pc_provider_idx"  ON "provider_configs" ("provider_id");
CREATE INDEX IF NOT EXISTS "pc_enabled_idx"   ON "provider_configs" ("enabled");

CREATE TABLE IF NOT EXISTS "remote_endpoints" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL,
  "name"              text NOT NULL,
  "type"              text NOT NULL,
  "base_url"          text NOT NULL,
  "api_key_encrypted" text,
  "api_key_iv"        text,
  "model_ids"         text[] NOT NULL DEFAULT '{}',
  "enabled"           boolean NOT NULL DEFAULT true,
  "priority"          integer NOT NULL DEFAULT 10,
  "health_status"     text NOT NULL DEFAULT 'unknown',
  "last_health_check" bigint,
  "latency_ms"        real,
  "notes"             text,
  "created_at"        bigint NOT NULL,
  "updated_at"        bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "re_workspace_idx" ON "remote_endpoints" ("workspace_id");
CREATE INDEX IF NOT EXISTS "re_enabled_idx"   ON "remote_endpoints" ("enabled");
CREATE INDEX IF NOT EXISTS "re_health_idx"    ON "remote_endpoints" ("health_status");

CREATE TABLE IF NOT EXISTS "provider_health_log" (
  "id"           text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "provider_id"  text NOT NULL,
  "source_type"  text NOT NULL DEFAULT 'provider',
  "status"       text NOT NULL,
  "latency_ms"   real,
  "error_rate"   real NOT NULL DEFAULT 0,
  "checked_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "phl_workspace_idx" ON "provider_health_log" ("workspace_id");
CREATE INDEX IF NOT EXISTS "phl_provider_idx"  ON "provider_health_log" ("provider_id");
CREATE INDEX IF NOT EXISTS "phl_checked_idx"   ON "provider_health_log" ("checked_at");

CREATE TABLE IF NOT EXISTS "provider_failures" (
  "id"                   text PRIMARY KEY,
  "workspace_id"         text NOT NULL,
  "provider_id"          text NOT NULL,
  "endpoint_id"          text,
  "task_type"            text NOT NULL,
  "model"                text NOT NULL,
  "error_type"           text NOT NULL,
  "error_message"        text NOT NULL,
  "fallback_used"        boolean NOT NULL DEFAULT false,
  "fallback_provider_id" text,
  "cost_usd"             real NOT NULL DEFAULT 0,
  "latency_ms"           real,
  "created_at"           bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "pf_workspace_idx" ON "provider_failures" ("workspace_id");
CREATE INDEX IF NOT EXISTS "pf_provider_idx"  ON "provider_failures" ("provider_id");
CREATE INDEX IF NOT EXISTS "pf_created_idx"   ON "provider_failures" ("created_at");
CREATE INDEX IF NOT EXISTS "pf_error_idx"     ON "provider_failures" ("error_type");

CREATE TABLE IF NOT EXISTS "provider_budgets" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL UNIQUE,
  "daily_limit_usd"   real NOT NULL DEFAULT 10,
  "monthly_limit_usd" real NOT NULL DEFAULT 100,
  "daily_spend_usd"   real NOT NULL DEFAULT 0,
  "monthly_spend_usd" real NOT NULL DEFAULT 0,
  "daily_reset_at"    bigint NOT NULL,
  "monthly_reset_at"  bigint NOT NULL,
  "alert_threshold"   real NOT NULL DEFAULT 0.8,
  "updated_at"        bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "pb_workspace_idx" ON "provider_budgets" ("workspace_id");
