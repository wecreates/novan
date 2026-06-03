-- R146.182 — Voice layer: wake word + persona + voice ID + cross-device session sync.

CREATE TABLE IF NOT EXISTS voice_persona (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  wake_word     text NOT NULL DEFAULT 'hey novan',
  voice_id      text NOT NULL,                  -- elevenlabs/playht voice id
  voice_provider text NOT NULL DEFAULT 'elevenlabs',
  persona_prompt text NOT NULL,
  tone          text NOT NULL DEFAULT 'precise',
  response_speed text NOT NULL DEFAULT 'normal', -- slow|normal|fast
  proactive_enabled boolean NOT NULL DEFAULT true,
  always_on     boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active',
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vp_ws_idx ON voice_persona(workspace_id, name);

CREATE TABLE IF NOT EXISTS session_sync (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  user_id       text NOT NULL,
  device_id     text NOT NULL,
  device_kind   text,                            -- phone | tablet | desktop | watch | tv | car
  active_chat_id text,
  draft_input   text,
  draft_voice_state jsonb NOT NULL DEFAULT '{}',
  last_ping_at  bigint NOT NULL,
  last_handoff_to text,
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ss_user_device_idx ON session_sync(workspace_id, user_id, device_id);
CREATE INDEX IF NOT EXISTS ss_user_ping_idx ON session_sync(workspace_id, user_id, last_ping_at DESC);
