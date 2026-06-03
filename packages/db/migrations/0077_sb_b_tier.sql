-- R146.149 — SB B-tier 11-15: decision journal + idea incubator + Q&A + maturity

CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  question        TEXT NOT NULL,
  reasoning       TEXT NOT NULL,
  expected_outcome TEXT,
  alternatives    JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence      REAL NOT NULL DEFAULT 0.5,
  review_at       BIGINT NOT NULL,
  actual_outcome  TEXT,
  calibration_score REAL,
  decided_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS dec_ws_idx     ON decisions(workspace_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS dec_review_idx ON decisions(workspace_id, review_at);

CREATE TABLE IF NOT EXISTS ideas_incubator (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'incubating',  -- incubating | promoted | discarded
  mention_count   INTEGER NOT NULL DEFAULT 0,
  last_mentioned_at BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ii_ws_status_idx ON ideas_incubator(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS qa_pairs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  conversation_id TEXT,
  chunk_id        TEXT,
  reuse_count     INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS qa_ws_idx ON qa_pairs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS concept_maturity (
  workspace_id    TEXT NOT NULL,
  concept         TEXT NOT NULL,
  reference_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at   BIGINT NOT NULL,
  last_seen_at    BIGINT NOT NULL,
  maturity        TEXT NOT NULL DEFAULT 'fresh',  -- fresh | growing | mature | archived
  PRIMARY KEY (workspace_id, concept)
);
CREATE INDEX IF NOT EXISTS cm_maturity_idx ON concept_maturity(workspace_id, maturity, last_seen_at);
