-- R146.211-214 — workplace layer: persistent memory, chapters,
-- background notifications, hooks, NL scheduled tasks, spawn-task chips,
-- operator questions, MCP connector marketplace.

CREATE TABLE IF NOT EXISTS workspace_memory (
  workspace_id  text NOT NULL,
  key           text NOT NULL,
  value         text NOT NULL,
  scope         text NOT NULL DEFAULT 'general',
  importance    integer NOT NULL DEFAULT 50,
  updated_at    bigint NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
CREATE INDEX IF NOT EXISTS wm_scope_idx ON workspace_memory (workspace_id, scope, importance DESC);

CREATE TABLE IF NOT EXISTS session_chapters (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  conversation_id text,
  title         text NOT NULL,
  summary       text,
  message_anchor_id text,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sc_ws_idx ON session_chapters (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS event_hooks (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  event_pattern text NOT NULL,
  op_name       text NOT NULL,
  op_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  fires         integer NOT NULL DEFAULT 0,
  last_fired_at bigint,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS eh_ws_name_uniq ON event_hooks (workspace_id, name);
CREATE INDEX IF NOT EXISTS eh_pattern_idx ON event_hooks (enabled, event_pattern);

CREATE TABLE IF NOT EXISTS nl_schedules (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  description   text NOT NULL,
  cron_expr     text NOT NULL,
  op_name       text NOT NULL,
  op_params     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  next_run_at   bigint,
  last_run_at   bigint,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS nls_next_idx ON nl_schedules (enabled, next_run_at);

CREATE TABLE IF NOT EXISTS spawn_tasks (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  title         text NOT NULL,
  tldr          text,
  prompt        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  spawned_at    bigint,
  dismissed_at  bigint,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS st_ws_status_idx ON spawn_tasks (workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS operator_questions (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  question      text NOT NULL,
  options       jsonb NOT NULL,
  multi_select  boolean NOT NULL DEFAULT false,
  context       text,
  answer        jsonb,
  status        text NOT NULL DEFAULT 'pending',
  asked_at      bigint NOT NULL,
  answered_at   bigint
);
CREATE INDEX IF NOT EXISTS oq_ws_status_idx ON operator_questions (workspace_id, status, asked_at DESC);

CREATE TABLE IF NOT EXISTS mcp_connectors (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  category      text NOT NULL,
  description   text,
  endpoint_url  text,
  auth_kind     text,
  installed     boolean NOT NULL DEFAULT false,
  enabled       boolean NOT NULL DEFAULT false,
  meta          jsonb,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_ws_name_uniq ON mcp_connectors (workspace_id, name);
