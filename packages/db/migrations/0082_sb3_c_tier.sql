-- R146.158 — SB3 C-tier: dream journal + body data + public publish + inheritance

CREATE TABLE IF NOT EXISTS dream_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  date            TEXT NOT NULL,
  body            TEXT NOT NULL,
  themes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  vivid           BOOLEAN NOT NULL DEFAULT FALSE,
  chunk_id        TEXT,
  recorded_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS de_ws_date_idx ON dream_entries(workspace_id, date);

CREATE TABLE IF NOT EXISTS body_metrics (
  workspace_id    TEXT NOT NULL,
  date            TEXT NOT NULL,
  metric          TEXT NOT NULL,             -- 'sleep_min' | 'hrv' | 'steps' | 'weight_kg' | 'rhr' | 'workout_min'
  value           REAL NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  recorded_at     BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, date, metric)
);

CREATE TABLE IF NOT EXISTS public_publishes (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  chunk_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  view_count      INTEGER NOT NULL DEFAULT 0,
  published_at    BIGINT NOT NULL,
  unpublished_at  BIGINT
);
CREATE INDEX IF NOT EXISTS pp_ws_idx ON public_publishes(workspace_id, published_at DESC);

CREATE TABLE IF NOT EXISTS inheritance_manifests (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  recipient_hint  TEXT NOT NULL,             -- 'self_future' | 'spouse' | 'cofounder' | etc.
  body_md         TEXT NOT NULL,
  manifest_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS im_ws_idx ON inheritance_manifests(workspace_id, generated_at DESC);
