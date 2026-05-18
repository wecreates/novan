-- 0019_code_agent.sql
-- Closes the autonomy loop: proposals → patches → sandbox-validated artifacts.
-- Strict safety boundary: paths allowlisted, content scanned, operator gate.

-- ─── Generated code patches ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "code_patches" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL,
  "proposal_id"       text NOT NULL,
  "status"            text NOT NULL DEFAULT 'pending', -- pending | generated | safety_blocked | sandbox_failed | validated | merged | rejected
  "agent"             text NOT NULL DEFAULT 'template', -- groq | gemini | template
  "files"             jsonb NOT NULL DEFAULT '[]',     -- [{path, contents, op}]
  "safety_report"     jsonb NOT NULL DEFAULT '{}',
  "sandbox_report"    jsonb NOT NULL DEFAULT '{}',
  "block_reason"      text,
  "tokens_used"       integer NOT NULL DEFAULT 0,
  "cost_usd_used"     real NOT NULL DEFAULT 0,
  "created_at"        bigint NOT NULL,
  "updated_at"        bigint NOT NULL,
  "completed_at"      bigint
);
CREATE INDEX IF NOT EXISTS "patches_workspace_idx" ON "code_patches" ("workspace_id");
CREATE INDEX IF NOT EXISTS "patches_proposal_idx"  ON "code_patches" ("proposal_id");
CREATE INDEX IF NOT EXISTS "patches_status_idx"    ON "code_patches" ("status");

-- ─── Commit outcomes (learn from own commits) ───────────────────────────
CREATE TABLE IF NOT EXISTS "commit_outcomes" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL,
  "git_sha"           text NOT NULL,
  "evaluated_at"      bigint NOT NULL,
  "horizon_days"      integer NOT NULL DEFAULT 7,
  "incidents_after"   integer NOT NULL DEFAULT 0,
  "drift_warnings_after" integer NOT NULL DEFAULT 0,
  "match_rate_delta"  real,                 -- chains-since-commit match rate minus baseline
  "verdict"           text NOT NULL,        -- positive | neutral | regression
  "notes"             jsonb NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS "co_sha_unique" ON "commit_outcomes" ("workspace_id", "git_sha");
CREATE INDEX IF NOT EXISTS "co_verdict_idx" ON "commit_outcomes" ("verdict");

-- ─── Auto-discovered capabilities ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "discovered_capabilities" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "service_file"   text NOT NULL,           -- e.g. "economic-intelligence.ts"
  "exports_count"  integer NOT NULL DEFAULT 0,
  "first_seen_at"  bigint NOT NULL,
  "last_seen_at"   bigint NOT NULL,
  "maturity"       text NOT NULL DEFAULT 'basic'
);
CREATE UNIQUE INDEX IF NOT EXISTS "dc_file_unique" ON "discovered_capabilities" ("workspace_id", "service_file");
