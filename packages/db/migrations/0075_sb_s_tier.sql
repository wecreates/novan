-- R146.147 — Second-brain S-tier: wiki-links + daily notes + tags + outline + capture

CREATE TABLE IF NOT EXISTS memory_links (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  src_chunk_id    TEXT NOT NULL,
  dst_chunk_id    TEXT NOT NULL,
  link_type       TEXT NOT NULL DEFAULT 'wiki',   -- 'wiki' | 'tag' | 'parent' | 'mention'
  context         TEXT,                            -- excerpt around the link
  created_at      BIGINT NOT NULL,
  UNIQUE (workspace_id, src_chunk_id, dst_chunk_id, link_type)
);
CREATE INDEX IF NOT EXISTS ml_src_idx ON memory_links(workspace_id, src_chunk_id);
CREATE INDEX IF NOT EXISTS ml_dst_idx ON memory_links(workspace_id, dst_chunk_id);
CREATE INDEX IF NOT EXISTS ml_type_idx ON memory_links(workspace_id, link_type);

CREATE TABLE IF NOT EXISTS daily_notes (
  workspace_id    TEXT NOT NULL,
  date            TEXT NOT NULL,                   -- 'YYYY-MM-DD' UTC
  chunk_id        TEXT NOT NULL,                   -- ref to memory_chunks
  prev_date       TEXT,
  next_date       TEXT,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, date)
);

CREATE TABLE IF NOT EXISTS memory_tags (
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  tag             TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'auto',    -- 'auto' | 'manual'
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id, tag)
);
CREATE INDEX IF NOT EXISTS mt_tag_idx ON memory_tags(workspace_id, tag);

CREATE TABLE IF NOT EXISTS memory_outline (
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  parent_chunk_id TEXT,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  collapsed       BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS mo_parent_idx ON memory_outline(workspace_id, parent_chunk_id, sort_order);

CREATE TABLE IF NOT EXISTS inbox_items (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,                   -- 'url' | 'voice' | 'photo' | 'text' | 'note'
  raw_content     TEXT NOT NULL,
  source_url      TEXT,
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processed_chunk_id TEXT,                          -- created memory chunk after processing
  extracted       JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at     BIGINT NOT NULL,
  processed_at    BIGINT
);
CREATE INDEX IF NOT EXISTS ii_ws_idx        ON inbox_items(workspace_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS ii_unprocessed_idx ON inbox_items(workspace_id, processed) WHERE processed = FALSE;
