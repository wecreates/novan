-- R146.140 — A-tier AI: semantic cache + prompt templates

CREATE TABLE IF NOT EXISTS inference_cache (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  prompt_hash     TEXT NOT NULL,
  prompt_embedding vector(768),
  response        TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  provider        TEXT NOT NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL,
  last_hit_at     BIGINT
);
CREATE INDEX IF NOT EXISTS ic_ws_idx       ON inference_cache(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ic_hash_idx     ON inference_cache(workspace_id, prompt_hash);
CREATE INDEX IF NOT EXISTS ic_embed_idx    ON inference_cache USING ivfflat (prompt_embedding vector_cosine_ops) WITH (lists = 50);

CREATE TABLE IF NOT EXISTS prompt_templates_v2 (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  body            TEXT NOT NULL,
  input_schema    JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_schema   JSONB,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, name, version)
);
CREATE INDEX IF NOT EXISTS ptv2_ws_idx     ON prompt_templates_v2(workspace_id, name);
CREATE INDEX IF NOT EXISTS ptv2_active_idx ON prompt_templates_v2(workspace_id, active);
