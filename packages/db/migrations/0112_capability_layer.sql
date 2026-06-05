-- R146.206-210 — capability layer: skills, sub-agents, adversarial votes,
-- workflows. Table names prefixed `operator_*` / `subagent_*` /
-- `adversarial_*` to avoid colliding with pre-existing `skills` /
-- `workflows` / `workflow_runs` tables from earlier blueprint rounds.

CREATE TABLE IF NOT EXISTS operator_skills (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  description   text NOT NULL,
  when_to_use   text,
  instructions  text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  uses          integer NOT NULL DEFAULT 0,
  wins          integer NOT NULL DEFAULT 0,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_skills_ws_name_uniq ON operator_skills (workspace_id, name);
CREATE INDEX IF NOT EXISTS operator_skills_ws_idx ON operator_skills (workspace_id);

CREATE TABLE IF NOT EXISTS subagent_runs (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  parent_op     text,
  prompt        text NOT NULL,
  schema        jsonb,
  result        jsonb,
  error         text,
  tokens_in     integer NOT NULL DEFAULT 0,
  tokens_out    integer NOT NULL DEFAULT 0,
  cost_usd      real NOT NULL DEFAULT 0,
  started_at    bigint NOT NULL,
  ended_at      bigint
);
CREATE INDEX IF NOT EXISTS sar_ws_idx ON subagent_runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS adversarial_verdicts (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  subject       text NOT NULL,
  claim         text NOT NULL,
  voters        integer NOT NULL,
  refuted_count integer NOT NULL,
  votes         jsonb NOT NULL,
  decision      text NOT NULL,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS av_ws_idx ON adversarial_verdicts (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operator_workflows (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  description   text,
  script        text NOT NULL,
  version       integer NOT NULL DEFAULT 1,
  runs_count    integer NOT NULL DEFAULT 0,
  last_run_at   bigint,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_workflows_ws_name_uniq ON operator_workflows (workspace_id, name);

CREATE TABLE IF NOT EXISTS operator_workflow_runs (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  workflow_id   text NOT NULL,
  args          jsonb,
  result        jsonb,
  error         text,
  log           text,
  started_at    bigint NOT NULL,
  ended_at      bigint
);
CREATE INDEX IF NOT EXISTS owr_ws_idx ON operator_workflow_runs (workspace_id, started_at DESC);
