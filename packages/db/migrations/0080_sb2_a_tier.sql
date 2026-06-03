-- R146.152 — SB2 A-tier 6-10

CREATE TABLE IF NOT EXISTS digest_subscriptions (
  workspace_id    TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  cadence         TEXT NOT NULL DEFAULT 'weekly',     -- weekly | monthly
  last_sent_at    BIGINT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_annotations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  body            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT 'yellow',
  start_offset    INTEGER,                            -- where in chunk text
  end_offset      INTEGER,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ca_chunk_idx ON chunk_annotations(chunk_id);

CREATE TABLE IF NOT EXISTS chunk_revisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  prev_content    TEXT NOT NULL,
  diff_summary    TEXT,
  edited_by       TEXT NOT NULL DEFAULT 'operator',
  edited_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS cr_chunk_idx ON chunk_revisions(workspace_id, chunk_id, edited_at DESC);

CREATE TABLE IF NOT EXISTS chunk_confidence (
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.7,
  sources         JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id)
);
