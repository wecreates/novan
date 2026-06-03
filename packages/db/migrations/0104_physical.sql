-- R146.184 — Physical world bridges: Home Assistant + Workshop fab + Wearable biometrics.

CREATE TABLE IF NOT EXISTS physical_endpoint (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  kind            text NOT NULL,            -- home_assistant | octoprint | bambu | linuxcnc | tesla
  label           text NOT NULL,
  base_url        text NOT NULL,
  vault_secret_id text,                      -- API token / password
  metadata        jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active',
  last_seen_at    bigint,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pe_ws_kind_idx ON physical_endpoint(workspace_id, kind, status);

CREATE TABLE IF NOT EXISTS physical_action_log (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  endpoint_id   text NOT NULL,
  kind          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  result        jsonb NOT NULL DEFAULT '{}',
  success       boolean NOT NULL DEFAULT false,
  error         text,
  started_at    bigint NOT NULL,
  ended_at      bigint
);
CREATE INDEX IF NOT EXISTS pal_ws_idx ON physical_action_log(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS biometric_event (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  user_id       text,
  source        text NOT NULL,              -- apple_health | garmin | fitbit | whoop | oura | manual
  kind          text NOT NULL,              -- steps | heart_rate | hrv | sleep | workout | stress | spo2 | temp
  value         jsonb NOT NULL DEFAULT '{}',
  unit          text,
  recorded_at   bigint NOT NULL,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS be_ws_kind_idx ON biometric_event(workspace_id, kind, recorded_at DESC);
CREATE INDEX IF NOT EXISTS be_ws_source_idx ON biometric_event(workspace_id, source, recorded_at DESC);
