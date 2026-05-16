-- Phase 1: Remote Runtime Foundation
-- worker_registry, execution_leases, provider_scores

-- ─── Worker Registry ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "worker_registry" (
  "id"                 text PRIMARY KEY,
  "workspace_id"       text NOT NULL,
  "worker_name"        text NOT NULL,
  "worker_type"        text NOT NULL DEFAULT 'cpu',  -- cpu | gpu | browser | hybrid
  "capabilities"       text[] NOT NULL DEFAULT ARRAY[]::text[],
  "endpoint_url"       text,
  "metadata"           jsonb NOT NULL DEFAULT '{}',
  "status"             text NOT NULL DEFAULT 'idle',  -- idle | busy | offline | draining
  "max_concurrent"     integer NOT NULL DEFAULT 1,
  "active_leases"      integer NOT NULL DEFAULT 0,
  "last_heartbeat_at"  bigint,
  "registered_at"      bigint NOT NULL,
  "stale_threshold_ms" integer NOT NULL DEFAULT 60000,
  "created_at"         bigint NOT NULL,
  "updated_at"         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "wr_workspace_idx"  ON "worker_registry" ("workspace_id");
CREATE INDEX IF NOT EXISTS "wr_status_idx"     ON "worker_registry" ("status");
CREATE INDEX IF NOT EXISTS "wr_type_idx"       ON "worker_registry" ("worker_type");
CREATE INDEX IF NOT EXISTS "wr_heartbeat_idx"  ON "worker_registry" ("last_heartbeat_at");

-- ─── Execution Leases ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "execution_leases" (
  "id"           text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "worker_id"    text NOT NULL,
  "job_id"       text NOT NULL,
  "job_type"     text NOT NULL DEFAULT 'ai',  -- ai | browser | remote | workflow
  "status"       text NOT NULL DEFAULT 'active',  -- active | completed | expired | reclaimed | cancelled
  "started_at"   bigint NOT NULL,
  "expires_at"   bigint NOT NULL,
  "renewed_at"   bigint,
  "completed_at" bigint,
  "reclaimed_at" bigint,
  "timeout_ms"   integer NOT NULL DEFAULT 300000,
  "cost_usd"     real NOT NULL DEFAULT 0,
  "metadata"     jsonb NOT NULL DEFAULT '{}',
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "el_workspace_idx" ON "execution_leases" ("workspace_id");
CREATE INDEX IF NOT EXISTS "el_worker_idx"    ON "execution_leases" ("worker_id");
CREATE INDEX IF NOT EXISTS "el_job_idx"       ON "execution_leases" ("job_id");
CREATE INDEX IF NOT EXISTS "el_status_idx"    ON "execution_leases" ("status");
CREATE INDEX IF NOT EXISTS "el_expires_idx"   ON "execution_leases" ("expires_at");

-- ─── Provider Scores ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provider_scores" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL,
  "provider_id"       text NOT NULL,
  "latency_score"     real NOT NULL DEFAULT 1.0,
  "success_score"     real NOT NULL DEFAULT 1.0,
  "cost_score"        real NOT NULL DEFAULT 1.0,
  "capability_score"  real NOT NULL DEFAULT 1.0,
  "composite_score"   real NOT NULL DEFAULT 1.0,
  "sample_count"      integer NOT NULL DEFAULT 0,
  "last_latency_ms"   real,
  "last_error_rate"   real NOT NULL DEFAULT 0,
  "circuit_state"     text NOT NULL DEFAULT 'closed',  -- closed | open | half_open
  "circuit_opened_at" bigint,
  "circuit_failures"  integer NOT NULL DEFAULT 0,
  "created_at"        bigint NOT NULL,
  "updated_at"        bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "ps_workspace_provider_idx" ON "provider_scores" ("workspace_id", "provider_id");
CREATE INDEX IF NOT EXISTS "ps_workspace_idx"  ON "provider_scores" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ps_composite_idx"  ON "provider_scores" ("composite_score");
CREATE INDEX IF NOT EXISTS "ps_circuit_idx"    ON "provider_scores" ("circuit_state");
