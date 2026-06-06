-- R146.327 — relationship graph (#3) + onboarding (#5) + connector creds (#2) + clarify state (#4)

CREATE TABLE IF NOT EXISTS relationship_graph (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('person','business','vendor','partner','team','other')),
  name         text NOT NULL,
  attrs        jsonb NOT NULL DEFAULT '{}'::jsonb,
  links        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{otherId, rel, since}]
  last_seen_at bigint,
  created_at   bigint NOT NULL,
  updated_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS relg_ws_kind_idx ON relationship_graph (workspace_id, kind);
CREATE INDEX IF NOT EXISTS relg_ws_name_idx ON relationship_graph (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS workspace_setup_progress (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  steps        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {persona:true, firstGoal:false, ...}
  started_at   bigint NOT NULL,
  completed_at bigint,
  updated_at   bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_credentials (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id  text NOT NULL,                     -- 'slack','gmail','tiktok'...
  account_label text NOT NULL,                     -- operator-visible name
  status        text NOT NULL CHECK (status IN ('pending','active','revoked','error')),
  vault_key     text NOT NULL,                     -- key in secrets_vault, never the secret itself
  scopes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at    bigint,
  last_used_at  bigint,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL,
  UNIQUE (workspace_id, connector_id, account_label)
);
CREATE INDEX IF NOT EXISTS cc_ws_idx ON connector_credentials (workspace_id, status);

CREATE TABLE IF NOT EXISTS clarify_events (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id text,
  user_message  text NOT NULL,
  question      text NOT NULL,
  resolved      boolean NOT NULL DEFAULT false,
  answer        text,
  created_at    bigint NOT NULL,
  resolved_at   bigint
);
CREATE INDEX IF NOT EXISTS clarify_ws_unresolved_idx ON clarify_events (workspace_id, resolved, created_at);
