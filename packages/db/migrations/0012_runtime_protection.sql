-- Phase 2: Hard Runtime Protection Layer
-- budget_caps, execution_guards, provider_quarantine, queue_pauses

-- ─── Budget Caps (fine-grained per-scope limits) ─────────────────────────────

CREATE TABLE IF NOT EXISTS "budget_caps" (
  "id"                     text PRIMARY KEY,
  "workspace_id"           text NOT NULL,
  "scope_type"             text NOT NULL,  -- workspace | user | project | provider | workflow
  "scope_id"               text NOT NULL,  -- entity ID (workspaceId, userId, workflowId, …)
  "max_daily_usd"          real NOT NULL DEFAULT 0,       -- 0 = unlimited
  "max_monthly_usd"        real NOT NULL DEFAULT 0,
  "max_per_execution_usd"  real NOT NULL DEFAULT 0,
  "max_workflow_usd"       real NOT NULL DEFAULT 0,
  "current_daily_usd"      real NOT NULL DEFAULT 0,
  "current_monthly_usd"    real NOT NULL DEFAULT 0,
  "daily_reset_at"         bigint NOT NULL,
  "monthly_reset_at"       bigint NOT NULL,
  "enabled"                boolean NOT NULL DEFAULT true,
  "created_at"             bigint NOT NULL,
  "updated_at"             bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "bc_scope_idx"     ON "budget_caps" ("workspace_id", "scope_type", "scope_id");
CREATE INDEX        IF NOT EXISTS "bc_workspace_idx" ON "budget_caps" ("workspace_id");
CREATE INDEX        IF NOT EXISTS "bc_scope_type_idx" ON "budget_caps" ("scope_type");

-- ─── Execution Guards (preflight decisions) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS "execution_guards" (
  "id"                 text PRIMARY KEY,
  "workspace_id"       text NOT NULL,
  "execution_id"       text NOT NULL,   -- run_id / job_id
  "scope_type"         text NOT NULL,
  "scope_id"           text NOT NULL,
  "provider_id"        text NOT NULL,
  "estimated_cost_usd" real NOT NULL DEFAULT 0,
  "decision"           text NOT NULL,   -- approved | blocked
  "block_reason"       text,
  "cap_id"             text,            -- which cap triggered block
  "actual_cost_usd"    real,
  "created_at"         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "eg_workspace_idx"   ON "execution_guards" ("workspace_id");
CREATE INDEX IF NOT EXISTS "eg_execution_idx"   ON "execution_guards" ("execution_id");
CREATE INDEX IF NOT EXISTS "eg_decision_idx"    ON "execution_guards" ("decision");
CREATE INDEX IF NOT EXISTS "eg_created_idx"     ON "execution_guards" ("created_at");

-- ─── Provider Quarantine ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provider_quarantine" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "provider_id"     text NOT NULL,
  "reason"          text NOT NULL,
  "quarantined_at"  bigint NOT NULL,
  "release_at"      bigint,          -- null = manual release only
  "released_at"     bigint,
  "auto_release"    boolean NOT NULL DEFAULT false,
  "released_by"     text,
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "pq_workspace_provider_idx" ON "provider_quarantine" ("workspace_id", "provider_id");
CREATE INDEX        IF NOT EXISTS "pq_workspace_idx"          ON "provider_quarantine" ("workspace_id");
CREATE INDEX        IF NOT EXISTS "pq_released_idx"           ON "provider_quarantine" ("released_at");

-- ─── Queue Pauses ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "queue_pauses" (
  "id"           text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "queue_name"   text NOT NULL,
  "paused"       boolean NOT NULL DEFAULT false,
  "reason"       text,
  "paused_by"    text,
  "paused_at"    bigint,
  "resumed_at"   bigint,
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "qp_workspace_queue_idx" ON "queue_pauses" ("workspace_id", "queue_name");
CREATE INDEX        IF NOT EXISTS "qp_workspace_idx"        ON "queue_pauses" ("workspace_id");
CREATE INDEX        IF NOT EXISTS "qp_paused_idx"           ON "queue_pauses" ("paused");
