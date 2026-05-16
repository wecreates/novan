-- Migration 0007: businesses, risks, dead_letter_jobs
-- Idempotent — all statements use IF NOT EXISTS.
-- These tables are defined in schema.ts but had no explicit migration file.

-- ─── Enum: risk_severity (may already exist from initial push) ────────────────
DO $$ BEGIN
  CREATE TYPE "risk_severity" AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Businesses ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "businesses" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "name"         text NOT NULL,
  "domain"       text,
  "industry"     text,
  "stage"        text NOT NULL DEFAULT 'early',
  "health"       text NOT NULL DEFAULT 'green',
  "metrics"      jsonb NOT NULL DEFAULT '{}',
  "metadata"     jsonb NOT NULL DEFAULT '{}',
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "business_workspace_idx" ON "businesses" ("workspace_id");

-- ─── Risks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "risks" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "business_id"  text REFERENCES "businesses"("id"),
  "title"        text NOT NULL,
  "description"  text,
  "severity"     "risk_severity" NOT NULL DEFAULT 'medium',
  "probability"  real NOT NULL DEFAULT 0.5,
  "impact"       real NOT NULL DEFAULT 0.5,
  "risk_score"   real NOT NULL DEFAULT 0.25,
  "category"     text NOT NULL DEFAULT 'operational',
  "status"       text NOT NULL DEFAULT 'open',
  "mitigations"  jsonb NOT NULL DEFAULT '[]',
  "detected_at"  bigint NOT NULL,
  "resolved_at"  bigint,
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "risk_workspace_idx" ON "risks" ("workspace_id");
CREATE INDEX IF NOT EXISTS "risk_severity_idx"  ON "risks" ("severity");
CREATE INDEX IF NOT EXISTS "risk_score_idx"     ON "risks" ("risk_score");

-- ─── Dead-letter jobs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "dead_letter_jobs" (
  "id"               text PRIMARY KEY NOT NULL,
  "queue_name"       text NOT NULL,
  "job_id"           text NOT NULL,
  "job_name"         text NOT NULL,
  "workspace_id"     text NOT NULL,
  "payload"          jsonb NOT NULL DEFAULT '{}',
  "error"            text NOT NULL,
  "attempts"         integer NOT NULL DEFAULT 0,
  "worker_id"        text NOT NULL,
  "trace_id"         text,
  "first_failed_at"  bigint NOT NULL,
  "dead_lettered_at" bigint NOT NULL,
  "replayed_at"      bigint,
  "replayed_by"      text,
  "replay_run_id"    text
);

CREATE INDEX IF NOT EXISTS "dlq_workspace_idx"        ON "dead_letter_jobs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "dlq_queue_idx"            ON "dead_letter_jobs" ("queue_name");
CREATE INDEX IF NOT EXISTS "dlq_dead_lettered_at_idx" ON "dead_letter_jobs" ("dead_lettered_at");
