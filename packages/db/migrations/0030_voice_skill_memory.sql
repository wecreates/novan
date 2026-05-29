-- 0030_voice_skill_memory.sql
-- Per-operator voice preferences, skill observations, custom shortcuts.

CREATE TABLE IF NOT EXISTS "operator_voice_prefs" (
  "workspace_id"        text NOT NULL,
  "user_id"             text NOT NULL,
  "preferred_voice"     text,
  "preferred_speed"     real NOT NULL DEFAULT 1.0,        -- 0.5..1.5
  "preferred_length"    text NOT NULL DEFAULT 'short',    -- short | normal | detailed
  "confirmation_style"  text NOT NULL DEFAULT 'chip',     -- chip | spoken | both
  "preferred_wake"      text,
  "preferred_default_mode" text NOT NULL DEFAULT 'push_to_talk', -- push_to_talk | wake | hands_free
  "response_mode"       text NOT NULL DEFAULT 'normal',   -- normal | engineer | executive | brain_ui
  "created_at"          bigint NOT NULL,
  "updated_at"          bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "voice_skill_observations" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "user_id"       text,
  "session_id"    text,
  "kind"          text NOT NULL,            -- misunderstood | corrected | repeated | workflow | brain_node | preferred_action
  "phrase"        text,
  "intent_kind"   text,
  "from_intent"   text,                     -- for 'corrected': what we initially routed
  "to_intent"     text,                     -- for 'corrected': what the operator meant
  "confidence"    real,
  "node_id"       text,                     -- for 'brain_node' / 'workflow'
  "meta"          jsonb,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vso_workspace_idx" ON "voice_skill_observations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "vso_kind_idx"      ON "voice_skill_observations" ("kind");
CREATE INDEX IF NOT EXISTS "vso_phrase_idx"    ON "voice_skill_observations" ("phrase");
CREATE INDEX IF NOT EXISTS "vso_intent_idx"    ON "voice_skill_observations" ("intent_kind");
CREATE INDEX IF NOT EXISTS "vso_created_idx"   ON "voice_skill_observations" ("created_at");

CREATE TABLE IF NOT EXISTS "voice_shortcuts" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "user_id"       text,
  "phrase"        text NOT NULL,            -- spoken trigger (case-insensitive)
  "expansion"     text NOT NULL,            -- canonical command text to route
  "description"   text,
  "use_count"     integer NOT NULL DEFAULT 0,
  "last_used_at"  bigint,
  "enabled"       boolean NOT NULL DEFAULT true,
  "created_at"    bigint NOT NULL,
  "updated_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "vsc_workspace_phrase_idx" ON "voice_shortcuts" ("workspace_id", "phrase");
CREATE INDEX IF NOT EXISTS "vsc_user_idx"             ON "voice_shortcuts" ("user_id");
