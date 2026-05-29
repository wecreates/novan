-- 0029_voice_wake_handsfree.sql
-- Extends workspace_voice_prefs with wake phrase / hands-free / ambient settings.
-- Also adds voice_session_context.muted_until + locked flags for runtime
-- mute / lock-voice-actions handling.

ALTER TABLE "workspace_voice_prefs"
  ADD COLUMN IF NOT EXISTS "wake_phrases"               jsonb   NOT NULL DEFAULT '["hey novan","novan"]'::jsonb,
  ADD COLUMN IF NOT EXISTS "wake_enabled"               boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hands_free_enabled"         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hands_free_allowed_intents" jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "ambient_alerts_enabled"     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "ambient_severity_floor"     text    NOT NULL DEFAULT 'critical',
  ADD COLUMN IF NOT EXISTS "push_to_talk_default"       boolean NOT NULL DEFAULT true;

ALTER TABLE "voice_session_context"
  ADD COLUMN IF NOT EXISTS "muted_until"   bigint,
  ADD COLUMN IF NOT EXISTS "voice_locked"  boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "voice_ambient_briefings" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "kind"          text NOT NULL,         -- incident | budget | approval | agent_failure | security
  "severity"      text NOT NULL,         -- normal | high | critical
  "summary"       text NOT NULL,
  "source_event_id" text,
  "delivered_at"  bigint,                -- null until the operator hears it
  "acked_at"      bigint,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vab_workspace_idx" ON "voice_ambient_briefings" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vab_severity_idx"  ON "voice_ambient_briefings" ("severity");
CREATE INDEX IF NOT EXISTS "vab_created_idx"   ON "voice_ambient_briefings" ("created_at");
