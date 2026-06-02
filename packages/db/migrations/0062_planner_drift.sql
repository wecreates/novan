-- R146.132 — cross-account planning + LLM drift fingerprints

CREATE TABLE IF NOT EXISTS account_niches (
  workspace_id     TEXT NOT NULL,
  connector_account_id TEXT NOT NULL,
  niche_tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  posting_slots    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- preferred minute-of-day slots e.g. [540, 720, 1080]
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, connector_account_id)
);

CREATE TABLE IF NOT EXISTS llm_output_fingerprints (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  prompt_key    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  shape_hash    TEXT NOT NULL,
  shape_sample  JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS llm_fp_key_idx       ON llm_output_fingerprints(workspace_id, prompt_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS llm_fp_shape_idx     ON llm_output_fingerprints(workspace_id, prompt_key, shape_hash);
