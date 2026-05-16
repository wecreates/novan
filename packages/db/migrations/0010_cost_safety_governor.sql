-- Migration 0010: Cost + Safety Governor
-- Adds budget_rules, kill_switches, runaway_jobs, budget_alerts tables.
-- Extends provider_budgets with weekly limit + per-job / per-session limits.

-- ── Extend providerBudgets ──────────────────────────────────────────────────

ALTER TABLE "provider_budgets"
  ADD COLUMN IF NOT EXISTS "weekly_limit_usd"          real    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "weekly_spend_usd"          real    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "weekly_reset_at"           bigint,
  ADD COLUMN IF NOT EXISTS "max_per_job_usd"           real    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_browser_session_secs"  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_ai_request_secs"       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "max_retries"               integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "max_concurrent_remote"     integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "hard_stop"                 boolean NOT NULL DEFAULT false;

-- ── Kill switches ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "kill_switches" (
  "id"            text    PRIMARY KEY,
  "workspace_id"  text    NOT NULL,
  "switch_type"   text    NOT NULL,  -- remote_worker | provider | browser_job | ai_request
  "enabled"       boolean NOT NULL DEFAULT false,
  "reason"        text,
  "enabled_by"    text,
  "enabled_at"    bigint,
  "disabled_at"   bigint,
  "created_at"    bigint  NOT NULL,
  "updated_at"    bigint  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ks_workspace_type_idx"
  ON "kill_switches" ("workspace_id", "switch_type");
CREATE INDEX IF NOT EXISTS "ks_workspace_idx" ON "kill_switches" ("workspace_id");

-- ── Runaway job log ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "runaway_jobs" (
  "id"            text    PRIMARY KEY,
  "workspace_id"  text    NOT NULL,
  "job_id"        text    NOT NULL,
  "job_type"      text    NOT NULL,  -- ai | browser | remote | workflow
  "endpoint_id"   text,
  "provider_id"   text,
  "cost_usd"      real    NOT NULL DEFAULT 0,
  "duration_ms"   bigint  NOT NULL DEFAULT 0,
  "reason"        text    NOT NULL, -- cost_exceeded | duration_exceeded | retry_exceeded | manual
  "stopped"       boolean NOT NULL DEFAULT false,
  "stopped_at"    bigint,
  "detected_at"   bigint  NOT NULL
);

CREATE INDEX IF NOT EXISTS "rj_workspace_idx"  ON "runaway_jobs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rj_job_id_idx"     ON "runaway_jobs" ("job_id");
CREATE INDEX IF NOT EXISTS "rj_detected_idx"   ON "runaway_jobs" ("detected_at");
CREATE INDEX IF NOT EXISTS "rj_stopped_idx"    ON "runaway_jobs" ("stopped");

-- ── Budget alerts ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "budget_alerts" (
  "id"            text    PRIMARY KEY,
  "workspace_id"  text    NOT NULL,
  "alert_type"    text    NOT NULL,  -- daily | weekly | monthly | per_job
  "threshold_pct" real    NOT NULL,  -- e.g. 0.8 = 80%
  "current_usd"   real    NOT NULL,
  "limit_usd"     real    NOT NULL,
  "dismissed"     boolean NOT NULL DEFAULT false,
  "dismissed_at"  bigint,
  "fired_at"      bigint  NOT NULL
);

CREATE INDEX IF NOT EXISTS "ba_workspace_idx" ON "budget_alerts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ba_fired_idx"     ON "budget_alerts" ("fired_at");
CREATE INDEX IF NOT EXISTS "ba_dismissed_idx" ON "budget_alerts" ("dismissed");
