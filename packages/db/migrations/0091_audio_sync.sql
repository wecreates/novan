-- R146.171 — Audio sync layer: lip-sync + ambient foley + script narration.

CREATE TABLE IF NOT EXISTS audio_sync_job (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  run_id        text,
  shot_id       text,
  kind          text NOT NULL,             -- lip_sync | foley | narrate_sync | narrate
  input_video   text,
  input_audio   text,
  script_text   text,
  scene_desc    text,
  output_path   text,
  provider      text,                       -- sieve | elevenlabs_sfx | playht | elevenlabs_tts
  cost_usd      real NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  error         text,
  created_at    bigint NOT NULL,
  ended_at      bigint
);
CREATE INDEX IF NOT EXISTS asj_ws_idx ON audio_sync_job(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asj_run_idx ON audio_sync_job(run_id, created_at);
CREATE INDEX IF NOT EXISTS asj_status_idx ON audio_sync_job(workspace_id, status);
