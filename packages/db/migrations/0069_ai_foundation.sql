-- R146.139 — AI foundation: semantic memory + eval suite

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_chunks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  content         TEXT NOT NULL,
  source_type     TEXT NOT NULL,             -- 'chat' | 'decision' | 'proposal' | 'doc' | 'event' | 'manual'
  source_id       TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding       vector(768),
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      BIGINT NOT NULL,
  accessed_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed_at BIGINT
);
CREATE INDEX IF NOT EXISTS mc_ws_idx       ON memory_chunks(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mc_pinned_idx   ON memory_chunks(workspace_id, pinned);
CREATE INDEX IF NOT EXISTS mc_embedding_idx ON memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS prompt_eval_cases (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  prompt_key      TEXT NOT NULL,
  input           JSONB NOT NULL,
  expected        JSONB,                      -- exact-match expected (optional)
  rubric          TEXT,                       -- LLM-graded rubric (optional)
  weight          REAL NOT NULL DEFAULT 1.0,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pec_key_idx ON prompt_eval_cases(workspace_id, prompt_key);

CREATE TABLE IF NOT EXISTS prompt_eval_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  prompt_key      TEXT NOT NULL,
  prompt_version  TEXT,
  cases_total     INTEGER NOT NULL DEFAULT 0,
  cases_passed    INTEGER NOT NULL DEFAULT 0,
  score           REAL NOT NULL DEFAULT 0,    -- 0..1 weighted pass rate
  details         JSONB NOT NULL DEFAULT '[]'::jsonb,
  ran_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS per_key_idx ON prompt_eval_runs(workspace_id, prompt_key, ran_at DESC);
