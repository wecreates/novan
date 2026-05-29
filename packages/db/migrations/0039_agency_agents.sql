-- 0039_agency_agents.sql
-- Agency-agents catalog + CEO delegations.
--
-- `agent_definitions` holds the static catalog imported from the
-- agency-agents-main markdown corpus (one row per .md file). The
-- existing `agents` table tracks runtime instances; definitions are
-- the templates those instances can specialize.
--
-- `agent_delegations` tracks each CEO→agent assignment so we can audit
-- what the brain delegated, to whom, and what came back.

CREATE TABLE IF NOT EXISTS "agent_definitions" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "slug"           text NOT NULL,
  "department"     text NOT NULL,
  "name"           text NOT NULL,
  "description"    text,
  "color"          text,
  "emoji"          text,
  "vibe"           text,
  "system_prompt"  text NOT NULL,
  "source_path"    text,
  "checksum"       text NOT NULL,
  "tags"           text[] NOT NULL DEFAULT '{}',
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agentdef_ws_slug_uniq"
  ON "agent_definitions" ("workspace_id", "slug");
CREATE INDEX IF NOT EXISTS "agentdef_department_idx"
  ON "agent_definitions" ("workspace_id", "department");

CREATE TABLE IF NOT EXISTS "agent_delegations" (
  "id"               text PRIMARY KEY,
  "workspace_id"     text NOT NULL,
  "definition_id"    text NOT NULL,
  "department"       text NOT NULL,
  "task"             text NOT NULL,
  "context"          jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result"           text,
  "tokens"           integer NOT NULL DEFAULT 0,
  "cost_usd"         real    NOT NULL DEFAULT 0,
  "provider"         text,
  "model"            text,
  "status"           text NOT NULL DEFAULT 'pending',
  "requested_by"     text NOT NULL DEFAULT 'ceo',
  "reasoning_chain_id" text,
  "started_at"       bigint,
  "completed_at"     bigint,
  "error"            text,
  "created_at"       bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "delegation_ws_idx"      ON "agent_delegations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "delegation_def_idx"     ON "agent_delegations" ("definition_id");
CREATE INDEX IF NOT EXISTS "delegation_created_idx" ON "agent_delegations" ("created_at");
CREATE INDEX IF NOT EXISTS "delegation_status_idx"  ON "agent_delegations" ("status");
