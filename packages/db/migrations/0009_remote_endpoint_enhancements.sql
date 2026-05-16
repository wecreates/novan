-- Migration 0009: Remote endpoint enhancements + usage log
-- Adds new columns to remote_endpoints, creates endpoint_usage_logs

-- New columns on remote_endpoints
ALTER TABLE "remote_endpoints"
  ADD COLUMN IF NOT EXISTS "custom_headers_encrypted" text,
  ADD COLUMN IF NOT EXISTS "custom_headers_iv"        text,
  ADD COLUMN IF NOT EXISTS "max_context_tokens"       integer NOT NULL DEFAULT 8192,
  ADD COLUMN IF NOT EXISTS "prompt_per_1k_usd"        real    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "output_per_1k_usd"        real    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "timeout_ms"               integer NOT NULL DEFAULT 60000,
  ADD COLUMN IF NOT EXISTS "paused"                   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "model_count"              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_model_discovery"     bigint,
  ADD COLUMN IF NOT EXISTS "last_discovery_error"     text;

CREATE INDEX IF NOT EXISTS "re_priority_idx" ON "remote_endpoints" ("priority");

-- Per-request usage log for remote endpoints
CREATE TABLE IF NOT EXISTS "endpoint_usage_logs" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "endpoint_id"   text NOT NULL,
  "model"         text NOT NULL,
  "task_type"     text NOT NULL,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd"      real    NOT NULL DEFAULT 0,
  "latency_ms"    integer NOT NULL DEFAULT 0,
  "streamed"      boolean NOT NULL DEFAULT false,
  "success"       boolean NOT NULL DEFAULT true,
  "error_message" text,
  "created_at"    bigint  NOT NULL
);

CREATE INDEX IF NOT EXISTS "eul_workspace_idx" ON "endpoint_usage_logs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "eul_endpoint_idx"  ON "endpoint_usage_logs" ("endpoint_id");
CREATE INDEX IF NOT EXISTS "eul_created_idx"   ON "endpoint_usage_logs" ("created_at");
