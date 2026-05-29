-- 0049_blueprint_persistence.sql — persistent stores for round 116:
--   portfolios       Holding-co tier above workspaces (1 portfolio → N workspaces).
--   eval_sets        Named eval suites for the AI Product pipeline.
--   eval_cases       Individual graded test cases inside an eval set.
--   policy_rules     Operator-editable governance rules layered on top of
--                    policy-engine.ts defaults.
--   approved_patterns  Knowledge-curator approved patterns that personas
--                      pull in as grounding additions.
--
-- All tables are idempotent (CREATE IF NOT EXISTS) so re-applying is safe.

-- ─── Portfolios (Holding-co tier) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  /* Operator-defined slug — used in URLs + display. Lowercase + hyphens. */
  slug            TEXT NOT NULL UNIQUE,
  description     TEXT,
  /* The owner identity — usually the operator's user_id. */
  owner_user_id   TEXT,
  /* Configuration: shared services, capital pool ceiling, governance overrides. */
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  /* Soft-deletion. */
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

-- Workspaces can belong to a portfolio (nullable — single-workspace
-- operators don't need to set up the holding-co tier).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS portfolio_id TEXT REFERENCES portfolios(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS workspaces_portfolio_idx ON workspaces(portfolio_id);

-- ─── Eval sets (AI Product pipeline) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_sets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  /* Which subsystem this eval set scores — chat, brain, persona X, etc. */
  target_subject  TEXT NOT NULL,
  /* Baseline pass rate the operator considers "production-ready". */
  baseline_pass_rate REAL NOT NULL DEFAULT 0.80,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS eval_sets_workspace_idx ON eval_sets(workspace_id);
CREATE INDEX IF NOT EXISTS eval_sets_target_idx    ON eval_sets(target_subject);

CREATE TABLE IF NOT EXISTS eval_cases (
  id              TEXT PRIMARY KEY,
  eval_set_id     TEXT NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  /* Input the system under test receives. */
  input           TEXT NOT NULL,
  /* What "passing" looks like — interpreted by the LLM-as-judge. */
  expected_behavior TEXT NOT NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  /* If the case was added because it WAS failing in prod, the regression
   * detector flags any future re-failure as a regression. */
  known_failure   BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS eval_cases_set_idx ON eval_cases(eval_set_id);

-- Per-run results — append-only ledger so we can chart trend lines.
CREATE TABLE IF NOT EXISTS eval_runs (
  id              TEXT PRIMARY KEY,
  eval_set_id     TEXT NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL,
  /* What changed — prompt version, model version, retrieval config, etc. */
  trigger         TEXT NOT NULL,
  total_cases     INTEGER NOT NULL,
  passed_count    INTEGER NOT NULL,
  avg_grade       REAL NOT NULL,
  /* Detail per-case stored as JSONB for compactness. */
  per_case        JSONB NOT NULL DEFAULT '[]'::jsonb,
  regressions     TEXT[] NOT NULL DEFAULT '{}',
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS eval_runs_set_idx       ON eval_runs(eval_set_id, created_at DESC);
CREATE INDEX IF NOT EXISTS eval_runs_workspace_idx ON eval_runs(workspace_id, created_at DESC);

-- ─── Policy rules (operator overrides) ──────────────────────────────────
-- Layered on top of the hardcoded defaults in policy-engine.ts. Operator
-- rules with the same `id` override the default. New `id` values are
-- appended to the rule set.
CREATE TABLE IF NOT EXISTS policy_rules (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  /* Rule kind — operator picks from a finite set; the engine knows how
   * to interpret each kind into a predicate. Kinds:
   *   spend_cap     limits non-operator spend in a window
   *   quiet_hours   blocks a persona in a UTC hour range
   *   op_block      hard-blocks one op-name unconditionally
   *   op_require_approval  forces approval for one op
   *   pattern_block blocks any op matching a regex
   */
  kind            TEXT NOT NULL,
  description     TEXT NOT NULL,
  /* Rule-specific parameters. Shape per kind:
   *   spend_cap     { window: 'day'|'week'|'month', ceilingUsd: number, callerScope?: 'agent'|'cron'|'any_non_operator' }
   *   quiet_hours   { persona: string, startHour: 0-23, endHour: 0-23 }
   *   op_block      { op: string }
   *   op_require_approval { op: string }
   *   pattern_block { pattern: string (regex) }
   */
  params          JSONB NOT NULL,
  /* Higher = evaluated first (matches policy-engine.ts contract). */
  priority        INTEGER NOT NULL DEFAULT 100,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS policy_rules_workspace_idx ON policy_rules(workspace_id);
CREATE INDEX IF NOT EXISTS policy_rules_enabled_idx   ON policy_rules(workspace_id, enabled);

-- ─── Approved knowledge patterns (closes the curator learning loop) ─────
CREATE TABLE IF NOT EXISTS approved_patterns (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  /* The curator's source category. */
  source          TEXT NOT NULL,    -- prompt_evolution | reasoning_chain | incident_postmortem | manual
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  /* Personas or specialist roles this pattern applies to. */
  applies_to      TEXT[] NOT NULL DEFAULT '{}',
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence      REAL NOT NULL DEFAULT 0.7,
  approved_by     TEXT NOT NULL,
  approved_at     BIGINT NOT NULL,
  /* Lets the operator retire a pattern without deleting (audit trail). */
  superseded_by   TEXT REFERENCES approved_patterns(id) ON DELETE SET NULL,
  archived        BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS approved_patterns_workspace_idx ON approved_patterns(workspace_id);
CREATE INDEX IF NOT EXISTS approved_patterns_applies_idx   ON approved_patterns(workspace_id) WHERE archived = FALSE;

-- Cartographer snapshots — persisted so the UI doesn't re-scan every load.
CREATE TABLE IF NOT EXISTS cartographer_snapshots (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  root_path       TEXT NOT NULL,
  file_count      INTEGER NOT NULL,
  /* Full snapshot payload — by_role / top_files / hot_imports / fragile_files / idioms. */
  snapshot        JSONB NOT NULL,
  generated_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS cartographer_workspace_idx ON cartographer_snapshots(workspace_id, generated_at DESC);
