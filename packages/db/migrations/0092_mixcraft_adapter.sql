-- R146.172 — Mixcraft Home Studio adapter for Novan music creation.
-- Novan generates a stems-bundle + manifest + PowerShell driver script.
-- Operator runs the script on their Windows machine; it downloads the
-- stems, launches Mixcraft, imports tracks at correct tempo + position,
-- and saves the project.

CREATE TABLE IF NOT EXISTS mixcraft_bundle (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  source_kind     text NOT NULL DEFAULT 'music_job',  -- music_job | manual | pai_run
  source_ref      text,                                -- music job id or run id
  name            text NOT NULL,
  bpm             integer NOT NULL DEFAULT 120,
  time_signature  text NOT NULL DEFAULT '4/4',
  sample_rate     integer NOT NULL DEFAULT 44100,
  bit_depth       integer NOT NULL DEFAULT 24,
  master_audio_url text,
  duration_sec    real,
  status          text NOT NULL DEFAULT 'ready',       -- draft | ready | imported | archived
  imported_at     bigint,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mb_ws_idx ON mixcraft_bundle(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS mixcraft_track (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  bundle_id     text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'audio',  -- drums | bass | chords | melody | vocal | fx | audio
  audio_url     text NOT NULL,
  midi_url      text,
  position_sec  real NOT NULL DEFAULT 0,
  duration_sec  real,
  volume_db     real NOT NULL DEFAULT 0,
  pan           real NOT NULL DEFAULT 0,         -- -1..1
  muted         boolean NOT NULL DEFAULT false,
  solo          boolean NOT NULL DEFAULT false,
  color_hex     text,
  order_idx     integer NOT NULL DEFAULT 0,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mt_bundle_idx ON mixcraft_track(bundle_id, order_idx);
CREATE INDEX IF NOT EXISTS mt_ws_idx ON mixcraft_track(workspace_id);
