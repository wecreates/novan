-- R146.128 — Tier 1 safety bundle: spend caps + moderation log + backup metadata

-- ── Spend caps: per-workspace daily/monthly LLM/image cost ceilings ──
CREATE TABLE IF NOT EXISTS spend_caps (
  workspace_id     TEXT PRIMARY KEY,
  daily_usd_cap    REAL NOT NULL DEFAULT 50.0,
  monthly_usd_cap  REAL NOT NULL DEFAULT 500.0,
  hard_block       BOOLEAN NOT NULL DEFAULT TRUE,   -- true = throw on overage; false = warn-only
  updated_at       BIGINT NOT NULL,
  updated_by       TEXT NOT NULL DEFAULT 'system'
);

-- ── Pre-post moderation log ──
CREATE TABLE IF NOT EXISTS moderation_results (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  content_type     TEXT NOT NULL,                   -- 'shortform' | 'caption' | 'image' | 'video'
  content_ref_id   TEXT,                            -- pipeline/clip/post id
  content_hash     TEXT NOT NULL,                   -- sha256 of analyzed text/url
  verdict          TEXT NOT NULL,                   -- 'pass' | 'flag' | 'block'
  reasons          JSONB NOT NULL DEFAULT '[]'::jsonb,
  category_scores  JSONB NOT NULL DEFAULT '{}'::jsonb,
  reviewer         TEXT NOT NULL,                   -- 'auto' | 'operator'
  created_at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mod_ws_idx  ON moderation_results(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mod_ref_idx ON moderation_results(content_ref_id);

-- ── Backup runs log ──
CREATE TABLE IF NOT EXISTS backup_runs (
  id               TEXT PRIMARY KEY,
  started_at       BIGINT NOT NULL,
  finished_at      BIGINT,
  status           TEXT NOT NULL,                   -- 'running' | 'ok' | 'failed'
  destination      TEXT NOT NULL,                   -- 's3://bucket/key' or 'spaces://...' etc
  size_bytes       BIGINT,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS bk_started_idx ON backup_runs(started_at DESC);
