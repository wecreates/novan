-- R146.185 — Tier B Jarvis-gap features.

CREATE TABLE IF NOT EXISTS companion_session (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,                      -- friday | edith | hopper | custom
  persona_id    text,                                -- ref to voice_persona
  model_tier    text NOT NULL DEFAULT 'light',       -- light | balanced
  status        text NOT NULL DEFAULT 'active',
  last_used_at  bigint,
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cs_ws_name_idx ON companion_session(workspace_id, name);

CREATE TABLE IF NOT EXISTS signal_classification (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  source        text NOT NULL,                      -- email | dm | comment | call | sms
  external_ref  text,
  content_excerpt text NOT NULL,
  kind          text NOT NULL,                      -- phish | spam | opportunity | threat | normal | urgent
  score         real NOT NULL DEFAULT 0,
  evidence      jsonb NOT NULL DEFAULT '{}',
  classified_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS scn_ws_idx ON signal_classification(workspace_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS scn_ws_kind_idx ON signal_classification(workspace_id, kind);

CREATE TABLE IF NOT EXISTS tactical_sim_run (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  scenario      text NOT NULL,
  assumptions   jsonb NOT NULL DEFAULT '{}',
  trials        integer NOT NULL DEFAULT 1000,
  results       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'done',
  ran_at        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS tsr_ws_idx ON tactical_sim_run(workspace_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS xr_scene (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  scene_json    jsonb NOT NULL DEFAULT '{}',         -- A-Frame entities
  ar_enabled    boolean NOT NULL DEFAULT true,
  vr_enabled    boolean NOT NULL DEFAULT true,
  updated_at    bigint NOT NULL,
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS xr_ws_name_idx ON xr_scene(workspace_id, name);
