-- R146.174 — CapCut full-access adapter (same bridge pattern as Mixcraft).
-- Generates a draft_content.json + asset bundle + PowerShell installer
-- that drops the project into CapCut's local drafts directory.

CREATE TABLE IF NOT EXISTS capcut_project (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  source_kind     text NOT NULL DEFAULT 'manual',   -- pai_run | music_job | manual
  source_ref      text,
  name            text NOT NULL,
  width           integer NOT NULL DEFAULT 1080,
  height          integer NOT NULL DEFAULT 1920,
  fps             integer NOT NULL DEFAULT 30,
  duration_ms     integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'ready',
  master_audio_url text,
  cover_url       text,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS cp_ws_idx ON capcut_project(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS capcut_clip (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  project_id      text NOT NULL,
  kind            text NOT NULL,                    -- video | audio | text | sticker | effect | image
  asset_url       text,                              -- nullable for text overlays
  track_idx       integer NOT NULL DEFAULT 0,
  start_ms        integer NOT NULL DEFAULT 0,
  duration_ms    integer NOT NULL DEFAULT 0,
  source_start_ms integer NOT NULL DEFAULT 0,
  -- jsonb: { x, y, scale, rotation, opacity, content?, font?, color? }
  transform       jsonb NOT NULL DEFAULT '{}',
  order_idx       integer NOT NULL DEFAULT 0,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS cc_project_idx ON capcut_clip(project_id, track_idx, start_ms);
CREATE INDEX IF NOT EXISTS cc_ws_idx ON capcut_clip(workspace_id);
