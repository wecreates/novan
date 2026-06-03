-- R146.150 — SB C-tier 16-20

CREATE TABLE IF NOT EXISTS memory_snapshots (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  snapshot_date   TEXT NOT NULL,             -- 'YYYY-MM-DD'
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  link_count      INTEGER NOT NULL DEFAULT 0,
  tag_count       INTEGER NOT NULL DEFAULT 0,
  manifest        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS voice_journals (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  date            TEXT NOT NULL,             -- 'YYYY-MM-DD' UTC
  audio_path      TEXT,
  transcript      TEXT,
  chunk_id        TEXT,
  duration_sec    INTEGER,
  status          TEXT NOT NULL DEFAULT 'recorded',
  recorded_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS vj_ws_date_idx ON voice_journals(workspace_id, date);

CREATE TABLE IF NOT EXISTS external_imports (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  source          TEXT NOT NULL,             -- 'kindle' | 'readwise' | 'pocket' | 'rss' | 'twitter'
  source_ref      TEXT,
  imported_count  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ei_ws_idx ON external_imports(workspace_id, imported_at DESC);
