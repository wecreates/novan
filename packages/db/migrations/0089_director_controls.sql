-- R146.166 — Higgsfield-style director controls layered onto PAI video runs.
-- A DirectorProfile is the "Cinema Studio" config (camera body + lens +
-- focal + aperture + stacked motion + grade) applied to every shot.
-- CharacterLock is a reference-image registry that auto-injects into
-- prompts so the same character appears across runs.

CREATE TABLE IF NOT EXISTS director_profile (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  name          text NOT NULL,
  camera_body   text NOT NULL DEFAULT 'arri_alexa_35',     -- key from CAMERA_BODIES
  lens          text NOT NULL DEFAULT 'zeiss_supreme_50',  -- key from LENS_KITS
  focal_mm      integer NOT NULL DEFAULT 50,
  aperture      real NOT NULL DEFAULT 2.8,
  shutter_deg   integer NOT NULL DEFAULT 180,
  motions       jsonb NOT NULL DEFAULT '[]',                -- 1..3 motion preset keys
  color_grade   text NOT NULL DEFAULT 'natural',            -- key from COLOR_GRADES
  vibe          text,                                       -- 'handheld_doc' | 'glossy_commercial' | 'a24_indie' | 'music_video' | 'youtuber_vlog'
  notes         text,
  status        text NOT NULL DEFAULT 'active',
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS dp_ws_name_idx ON director_profile(workspace_id, name);
CREATE INDEX IF NOT EXISTS dp_ws_idx ON director_profile(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS character_lock (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  name            text NOT NULL,
  description     text NOT NULL,
  reference_urls  jsonb NOT NULL DEFAULT '[]',
  appearance_seed integer,
  voice_id        text,
  status          text NOT NULL DEFAULT 'active',
  created_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cl_ws_name_idx ON character_lock(workspace_id, name);
CREATE INDEX IF NOT EXISTS cl_ws_idx ON character_lock(workspace_id, status);

-- Applied director profile per PAI run (one row per run). Lets us trace
-- which look produced which outcome for LEARN phase analysis.
CREATE TABLE IF NOT EXISTS director_run_binding (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  run_id        text NOT NULL,
  profile_id    text NOT NULL,
  character_ids jsonb NOT NULL DEFAULT '[]',
  bound_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS drb_run_idx ON director_run_binding(run_id);
CREATE INDEX IF NOT EXISTS drb_ws_idx ON director_run_binding(workspace_id, bound_at DESC);
