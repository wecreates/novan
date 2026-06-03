-- R146.173 — Deep song analysis + studio-quality reproduction + mastering chain.
-- Goal: listen to ANY reference song, identify every instrument + key + tempo
-- + structure, then reproduce at the same or better quality.

CREATE TABLE IF NOT EXISTS song_analysis (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  source_url      text NOT NULL,
  source_kind     text NOT NULL DEFAULT 'url',     -- url | file | youtube | spotify
  title           text,
  artist          text,
  duration_sec    real,
  bpm             real,
  key_signature   text,                            -- e.g. "C# minor"
  time_signature  text NOT NULL DEFAULT '4/4',
  mood            text,                            -- 'energetic' | 'melancholy' | ...
  energy          real,                            -- 0..1
  loudness_lufs   real,
  true_peak_db    real,
  sample_rate     integer NOT NULL DEFAULT 44100,
  bit_depth       integer NOT NULL DEFAULT 24,
  -- jsonb: [{ name, role, prominence (0..1), midi_url?, stem_url? }]
  instruments     jsonb NOT NULL DEFAULT '[]',
  -- jsonb: [{ section, startSec, durationSec, tags[] }]
  structure       jsonb NOT NULL DEFAULT '[]',
  stems_url       jsonb NOT NULL DEFAULT '{}',     -- { vocals, drums, bass, other, ... }
  analyzer        text,                            -- provider name
  status          text NOT NULL DEFAULT 'pending', -- pending | analyzing | ready | failed
  error           text,
  cost_usd        real NOT NULL DEFAULT 0,
  created_at      bigint NOT NULL,
  analyzed_at     bigint
);
CREATE INDEX IF NOT EXISTS sa_ws_idx ON song_analysis(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sa_ws_status_idx ON song_analysis(workspace_id, status);

CREATE TABLE IF NOT EXISTS music_recipe (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  source_analysis_id text,
  name            text NOT NULL,
  prompt          text NOT NULL,
  bpm             real NOT NULL DEFAULT 120,
  key_signature   text,
  time_signature  text NOT NULL DEFAULT '4/4',
  duration_sec    real NOT NULL DEFAULT 180,
  -- jsonb: [{ name, role, sound_descriptor, midi_pattern_hint? }]
  instruments     jsonb NOT NULL DEFAULT '[]',
  -- jsonb: [{ section, durationSec, dynamics, notes }]
  arrangement     jsonb NOT NULL DEFAULT '[]',
  style_refs      jsonb NOT NULL DEFAULT '[]',
  target_lufs     real NOT NULL DEFAULT -14,
  status          text NOT NULL DEFAULT 'ready',
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mr_ws_idx ON music_recipe(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS music_reproduction (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  recipe_id       text NOT NULL,
  provider        text NOT NULL,                   -- suno | udio | musicgen_large | riffusion | stable_audio_2
  generation_url  text,
  stems_url       jsonb NOT NULL DEFAULT '{}',
  mastered_url    text,
  master_job_id   text,
  duration_sec    real,
  cost_usd        real NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'queued',  -- queued | running | done | failed
  error           text,
  created_at      bigint NOT NULL,
  ended_at        bigint
);
CREATE INDEX IF NOT EXISTS mp_ws_idx ON music_reproduction(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mp_recipe_idx ON music_reproduction(recipe_id, created_at DESC);

CREATE TABLE IF NOT EXISTS master_job (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  input_url       text NOT NULL,
  reference_url   text,                            -- for matchering-style reference matching
  output_url      text,
  lufs_target     real NOT NULL DEFAULT -14,
  true_peak_target real NOT NULL DEFAULT -1,
  provider        text NOT NULL DEFAULT 'matchering', -- matchering | landr | cloudbounce | emastered
  cost_usd        real NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'queued',
  error           text,
  created_at      bigint NOT NULL,
  ended_at        bigint
);
CREATE INDEX IF NOT EXISTS mj_ws_idx ON master_job(workspace_id, created_at DESC);
