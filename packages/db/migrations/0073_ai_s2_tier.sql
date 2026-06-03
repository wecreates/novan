-- R146.143 — S-tier AI 21-25

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{name, opName, params, retryOn}]
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS wf_ws_idx ON workflows(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_workflow_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  workflow_id     TEXT NOT NULL,
  current_step    INTEGER NOT NULL DEFAULT 0,
  step_outputs    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'running',       -- running | paused | completed | failed
  error           TEXT,
  started_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS awfr_ws_idx     ON agent_workflow_runs(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS awfr_status_idx ON agent_workflow_runs(workspace_id, status);

CREATE TABLE IF NOT EXISTS finetune_cycles (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  base_model      TEXT NOT NULL,
  distill_dataset_id TEXT,
  finetune_job_id TEXT,
  ab_trial_id     TEXT,
  promoted        BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'queued',
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ftc_ws_idx ON finetune_cycles(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_chat_sessions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  transcript      TEXT NOT NULL DEFAULT '',
  audio_path      TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  started_at      BIGINT NOT NULL,
  ended_at        BIGINT
);
CREATE INDEX IF NOT EXISTS vcs_ws_idx ON voice_chat_sessions(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mcp_clients (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,
  allowed_ops     JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_used_at    BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_ws_idx ON mcp_clients(workspace_id);
