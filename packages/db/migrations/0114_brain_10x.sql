-- R146.216 — 10× brain primitives. Workflow journal for resume,
-- routing decisions for telemetry, skill outcome ledger.

CREATE TABLE IF NOT EXISTS workflow_journal (
  id              text PRIMARY KEY,
  workflow_run_id text NOT NULL,
  step_index      integer NOT NULL,
  step_kind       text NOT NULL,
  step_input      jsonb,
  step_output     jsonb,
  step_error      text,
  ms              integer,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS wfj_run_idx ON workflow_journal (workflow_run_id, step_index);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id             text PRIMARY KEY,
  workspace_id   text NOT NULL,
  task           text NOT NULL,
  chain_planned  jsonb NOT NULL,
  provider_used  text,
  health_scores  jsonb,
  reason         text,
  decided_at     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rd_ws_idx ON routing_decisions (workspace_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS skill_outcomes (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  skill_name      text NOT NULL,
  picker          text NOT NULL,
  won             boolean,
  cost_usd        real NOT NULL DEFAULT 0,
  steps_used      integer NOT NULL DEFAULT 0,
  context         text,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS so_skill_idx ON skill_outcomes (workspace_id, skill_name, created_at DESC);
