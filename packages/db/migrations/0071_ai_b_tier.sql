-- R146.141 — B-tier AI 11-15

CREATE TABLE IF NOT EXISTS agent_debates (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  question        TEXT NOT NULL,
  participants    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, prior}]
  rounds          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [[turn1, turn2, ...], ...]
  synthesis       TEXT,
  confidence      REAL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS adb_ws_idx ON agent_debates(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operator_profile (
  workspace_id    TEXT PRIMARY KEY,
  facts           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key, value, pinnedAt}]
  preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS synthetic_data_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  task_kind       TEXT NOT NULL,                       -- 'proposals' | 'classifications' | 'captions' | ...
  seed_examples   JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_count INTEGER NOT NULL DEFAULT 0,
  output_path     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sdr_ws_idx ON synthetic_data_runs(workspace_id, created_at DESC);
