-- 0017_self_aware_platform.sql
-- Closes the autonomy loop: code proposals, real action effects, self-knowledge.

-- ─── Code proposals (build plan → structured proposal) ──────────────────
CREATE TABLE IF NOT EXISTS "code_proposals" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "build_plan_id"   text,
  "capability_id"   text,
  "title"           text NOT NULL,
  "summary"         text NOT NULL,
  "files_to_create" jsonb NOT NULL DEFAULT '[]',
  "files_to_modify" jsonb NOT NULL DEFAULT '[]',
  "tests_required"  jsonb NOT NULL DEFAULT '[]',
  "risk_level"      text NOT NULL DEFAULT 'medium',
  "estimated_loc"   integer NOT NULL DEFAULT 0,
  "status"          text NOT NULL DEFAULT 'proposed',
  "reasoning"       jsonb NOT NULL DEFAULT '[]',
  "approval_id"     text,
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "cp_workspace_idx"  ON "code_proposals" ("workspace_id");
CREATE INDEX IF NOT EXISTS "cp_status_idx"     ON "code_proposals" ("status");
CREATE INDEX IF NOT EXISTS "cp_capability_idx" ON "code_proposals" ("capability_id");

-- ─── Worker concurrency overrides (action dispatcher → real effect) ─────
CREATE TABLE IF NOT EXISTS "worker_concurrency" (
  "workspace_id" text NOT NULL,
  "queue_name"   text NOT NULL,
  "factor"       real NOT NULL DEFAULT 1.0,
  "set_by"       text NOT NULL,
  "reason"       text,
  "updated_at"   bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "queue_name")
);

-- ─── Provider preferences (action dispatcher writes pending preferences) ─
CREATE TABLE IF NOT EXISTS "provider_preferences" (
  "workspace_id"       text NOT NULL,
  "task_type"          text NOT NULL,
  "preferred_provider" text NOT NULL,
  "set_by"             text NOT NULL,
  "status"             text NOT NULL DEFAULT 'pending',
  "reason"             text,
  "updated_at"         bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "task_type")
);

-- ─── Code state snapshots (git → memory linkage) ────────────────────────
CREATE TABLE IF NOT EXISTS "code_state_snapshots" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "git_sha"         text NOT NULL,
  "branch"          text,
  "commit_message"  text,
  "files_changed"   integer NOT NULL DEFAULT 0,
  "committed_at"    bigint NOT NULL,
  "captured_at"     bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "cs_sha_unique" ON "code_state_snapshots" ("workspace_id", "git_sha");
CREATE INDEX IF NOT EXISTS "cs_committed_idx"     ON "code_state_snapshots" ("committed_at");

-- ─── Chain embeddings (semantic search) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS "chain_embeddings" (
  "chain_id"     text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "vector"       text NOT NULL,
  "dim"          integer NOT NULL,
  "source_kind"  text,
  "created_at"   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ce_workspace_idx" ON "chain_embeddings" ("workspace_id");
