-- 0028_voice_disambiguation.sql
-- expected_next: pending clarification that the next utterance answers.
-- workspace_voice_prefs: cross-session operator preferences for voice.

ALTER TABLE "voice_session_context"
  ADD COLUMN IF NOT EXISTS "expected_next" jsonb;

CREATE TABLE IF NOT EXISTS "workspace_voice_prefs" (
  "workspace_id"          text PRIMARY KEY,
  "preferred_provider"    text,                   -- biases router toward this provider
  "preferred_preset"      text,
  "preferred_locale"      text NOT NULL DEFAULT 'en-US',
  "transcript_retained"   boolean NOT NULL DEFAULT true,
  "auto_confirm_low_risk" boolean NOT NULL DEFAULT false,
  "barge_in_enabled"      boolean NOT NULL DEFAULT true,
  "quality_weight"        real NOT NULL DEFAULT 0.15,  -- 0..1; how much rated quality biases routing
  "updated_at"            bigint NOT NULL
);
