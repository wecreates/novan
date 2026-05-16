-- Phase 4: Cloud/API-Only Runtime Mode
-- runtime_settings, user_provider_creds

-- ─── Runtime Settings ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "runtime_settings" (
  "id"                    text PRIMARY KEY,
  "workspace_id"          text NOT NULL,
  "mode"                  text NOT NULL DEFAULT 'local',  -- local | hybrid | cloud-api-only
  "allow_local_gpu"       boolean NOT NULL DEFAULT true,
  "allow_local_browser"   boolean NOT NULL DEFAULT true,
  "preferred_providers"   text[] NOT NULL DEFAULT '{}',
  "created_at"            bigint NOT NULL,
  "updated_at"            bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "rs_workspace_idx" ON "runtime_settings" ("workspace_id");
CREATE INDEX        IF NOT EXISTS "rs_mode_idx"      ON "runtime_settings" ("mode");

-- ─── Per-User Provider Credentials ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "user_provider_creds" (
  "id"                  text PRIMARY KEY,
  "workspace_id"        text NOT NULL,
  "user_id"             text NOT NULL,
  "provider_id"         text NOT NULL,
  "label"               text NOT NULL,
  "api_key_encrypted"   text,
  "api_key_iv"          text,
  "enabled"             boolean NOT NULL DEFAULT true,
  "last_validated_at"   bigint,
  "validation_status"   text NOT NULL DEFAULT 'unknown',  -- unknown | valid | invalid
  "created_at"          bigint NOT NULL,
  "updated_at"          bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "upc_user_provider_idx" ON "user_provider_creds" ("workspace_id", "user_id", "provider_id");
CREATE INDEX        IF NOT EXISTS "upc_workspace_idx"     ON "user_provider_creds" ("workspace_id");
CREATE INDEX        IF NOT EXISTS "upc_user_idx"          ON "user_provider_creds" ("user_id");
