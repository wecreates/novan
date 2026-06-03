-- R146.145 — B-tier AI 31-35

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash       TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  embedding       vector(768) NOT NULL,
  created_at      BIGINT NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ec_provider_idx ON embedding_cache(provider);

CREATE TABLE IF NOT EXISTS op_model_pins (
  workspace_id    TEXT NOT NULL,
  op_name         TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  pinned_at       BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, op_name)
);

CREATE TABLE IF NOT EXISTS adaptive_temperatures (
  workspace_id    TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  temperature     REAL NOT NULL DEFAULT 0.7,
  samples         INTEGER NOT NULL DEFAULT 0,
  avg_score       REAL NOT NULL DEFAULT 0,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, task_type)
);
