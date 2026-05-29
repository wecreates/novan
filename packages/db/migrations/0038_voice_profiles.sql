-- 0038_voice_profiles.sql
-- Voice cloning profiles (Coqui XTTS-v2 sidecar integration).
--
-- A profile binds a reference audio clip on disk to a friendly name +
-- target language. The TTS sidecar reads the WAV file and synthesizes
-- speech that mimics the speaker's timbre.
--
-- Honest scope:
--   ref_audio_path is a RELATIVE path under data/voice-refs/<workspace>/
--   so the sidecar can read it from a mounted directory. Files are not
--   stored as blobs in Postgres.
--
-- Ethical guardrail:
--   This system clones whatever audio the operator uploads. It does
--   NOT ship celebrity presets. Loading copyrighted / non-consenting
--   voices is the operator's legal responsibility — this column flag
--   tracks self-attested consent for auditability.

CREATE TABLE IF NOT EXISTS "voice_profiles" (
  "id"                 text PRIMARY KEY,
  "workspace_id"       text NOT NULL,
  "name"               text NOT NULL,
  "ref_audio_path"     text NOT NULL,
  "language"           text NOT NULL DEFAULT 'en',
  "consent_attested"   boolean NOT NULL DEFAULT false,
  "is_active"          boolean NOT NULL DEFAULT false,
  "duration_seconds"   real,
  "sample_rate"        integer,
  "notes"              text,
  "created_at"         bigint NOT NULL,
  "updated_at"         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "vp_workspace_idx" ON "voice_profiles" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vp_active_idx"    ON "voice_profiles" ("workspace_id", "is_active");
