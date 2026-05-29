-- 0034_operational_intelligence_primitives.sql
-- Four primitives toward the larger evolution directive:
--   #18 cognitive load — operator stress / overload tracking
--   #20 self-healing — recorded recovery actions for audit + replay
--   #21 behavioral anomaly — scored signals over events
--   #29 explainability — derived "why" chains (computed; only audit row needed)

CREATE TABLE IF NOT EXISTS "operator_load_snapshots" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "user_id"        text,
  "window_ms"      bigint NOT NULL,
  "event_volume"   integer NOT NULL,         -- events in window
  "alert_volume"   integer NOT NULL,         -- high/critical alerts in window
  "pending_count"  integer NOT NULL,         -- pending approvals + dry-runs
  "interruption_rate" real NOT NULL,         -- voice + UI interruptions / total turns
  "load_score"     real NOT NULL,            -- 0..1 composite
  "mode"           text NOT NULL,            -- calm | normal | deep | overload
  "recommendation" text,
  "created_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ols_workspace_idx" ON "operator_load_snapshots" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ols_created_idx"   ON "operator_load_snapshots" ("created_at");

CREATE TABLE IF NOT EXISTS "anomaly_signals" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "kind"          text NOT NULL,             -- api_abuse | secret_leak | auth_burst | runtime_spike | unsafe_automation
  "severity"      text NOT NULL,             -- low | medium | high | critical
  "score"         real NOT NULL,             -- 0..1
  "subject"       text,                      -- target id (user/api key/agent/etc.)
  "evidence"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_seen_at" bigint NOT NULL,
  "last_seen_at"  bigint NOT NULL,
  "occurrences"   integer NOT NULL DEFAULT 1,
  "acked_at"      bigint,
  "resolved_at"   bigint,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "as_workspace_idx" ON "anomaly_signals" ("workspace_id");
CREATE INDEX IF NOT EXISTS "as_kind_idx"      ON "anomaly_signals" ("kind");
CREATE INDEX IF NOT EXISTS "as_severity_idx"  ON "anomaly_signals" ("severity");
CREATE INDEX IF NOT EXISTS "as_created_idx"   ON "anomaly_signals" ("created_at");

CREATE TABLE IF NOT EXISTS "self_heal_actions" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "kind"          text NOT NULL,             -- requeue | restart_worker | clear_stuck | rotate_provider | clear_cache
  "target_kind"   text NOT NULL,             -- voice_session | dry_run | image_generation | workflow_run | other
  "target_id"     text NOT NULL,
  "reason"        text NOT NULL,
  "applied"       boolean NOT NULL DEFAULT false,
  "result"        jsonb,
  "created_at"    bigint NOT NULL,
  "applied_at"    bigint
);
CREATE INDEX IF NOT EXISTS "sha_workspace_idx" ON "self_heal_actions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sha_kind_idx"      ON "self_heal_actions" ("kind");
CREATE INDEX IF NOT EXISTS "sha_created_idx"   ON "self_heal_actions" ("created_at");
