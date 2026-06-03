-- R146.142 — AI C-tier 16-20: finetune jobs + batch jobs

CREATE TABLE IF NOT EXISTS finetune_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  provider        TEXT NOT NULL,             -- 'openai' | 'anthropic' | 'local'
  base_model      TEXT NOT NULL,
  dataset_path    TEXT NOT NULL,
  external_job_id TEXT,
  status          TEXT NOT NULL DEFAULT 'submitted',
  tuned_model_id  TEXT,
  cost_usd        REAL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS fj_ws_idx ON finetune_jobs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS batch_jobs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  provider        TEXT NOT NULL,
  external_batch_id TEXT,
  request_count   INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'submitted',
  cost_usd        REAL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS bj_ws_idx ON batch_jobs(workspace_id, created_at DESC);
