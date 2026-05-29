-- 0026_voice_speech_layer.sql
-- Provider-agnostic realtime speech layer.

CREATE TABLE IF NOT EXISTS "speech_provider_configs" (
  "id"                text PRIMARY KEY,
  "workspace_id"      text NOT NULL,
  "provider_id"       text NOT NULL,          -- openai_realtime | gemini_live | elevenlabs | azure_speech | deepgram_stt | cartesia_tts | assemblyai_stt | playht | custom
  "display_name"      text NOT NULL,
  "kind"              text NOT NULL,          -- realtime_s2s | stt | tts | custom
  "endpoint"          text,                   -- for custom/private endpoints
  "key_ref"           text,                   -- reference to vault entry (NEVER the raw key)
  "enabled"           boolean NOT NULL DEFAULT true,
  "priority"          integer NOT NULL DEFAULT 100,
  "preferred_voice"   text,
  "preferred_locale"  text NOT NULL DEFAULT 'en-US',
  "max_cost_per_min_usd" real NOT NULL DEFAULT 0.50,
  "max_latency_ms"    integer NOT NULL DEFAULT 1500,
  "supports_streaming"   boolean NOT NULL DEFAULT true,
  "supports_interruption" boolean NOT NULL DEFAULT false,
  "last_health_at"    bigint,
  "health_score"      real NOT NULL DEFAULT 1.0,    -- 0.0..1.0 rolling
  "last_latency_ms"   integer,
  "last_error"        text,
  "created_at"        bigint NOT NULL,
  "updated_at"        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "spc_workspace_idx" ON "speech_provider_configs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "spc_kind_idx"      ON "speech_provider_configs" ("kind");
CREATE UNIQUE INDEX IF NOT EXISTS "spc_ws_provider_uniq" ON "speech_provider_configs" ("workspace_id", "provider_id");

CREATE TABLE IF NOT EXISTS "voice_sessions" (
  "id"                  text PRIMARY KEY,
  "workspace_id"        text NOT NULL,
  "user_id"             text,
  "mode"                text NOT NULL,        -- realtime | fallback
  "preset"              text NOT NULL DEFAULT 'calm_operator',
  "selected_provider"   text NOT NULL,
  "fallback_chain"      jsonb NOT NULL DEFAULT '[]'::jsonb,
  "started_at"          bigint NOT NULL,
  "ended_at"            bigint,
  "first_audio_ms"      integer,             -- time-to-first-audio
  "avg_latency_ms"      integer,
  "total_cost_usd"      real NOT NULL DEFAULT 0,
  "failover_count"      integer NOT NULL DEFAULT 0,
  "blocked_commands"    integer NOT NULL DEFAULT 0,
  "transcript_retained" boolean NOT NULL DEFAULT true,
  "status"              text NOT NULL DEFAULT 'active'   -- active | ended | blocked | error
);
CREATE INDEX IF NOT EXISTS "vs_workspace_idx" ON "voice_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vs_started_idx"   ON "voice_sessions" ("started_at");
CREATE INDEX IF NOT EXISTS "vs_status_idx"    ON "voice_sessions" ("status");

CREATE TABLE IF NOT EXISTS "voice_events" (
  "id"            text PRIMARY KEY,
  "session_id"    text NOT NULL,
  "workspace_id"  text NOT NULL,
  "kind"          text NOT NULL,             -- transcript | tts | command | failover | block | confirm | mic_state | cost | error
  "role"          text,                      -- user | assistant | system
  "text"          text,
  "provider"      text,
  "latency_ms"    integer,
  "cost_usd"      real,
  "meta"          jsonb,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ve_session_idx"   ON "voice_events" ("session_id");
CREATE INDEX IF NOT EXISTS "ve_workspace_idx" ON "voice_events" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ve_kind_idx"      ON "voice_events" ("kind");
CREATE INDEX IF NOT EXISTS "ve_created_idx"   ON "voice_events" ("created_at");
