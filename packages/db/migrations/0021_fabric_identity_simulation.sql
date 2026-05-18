-- 0021_fabric_identity_simulation.sql
-- Distributed runtime fabric + identity consistency + simulation engine.

-- ─── 1. Runtime fabric nodes + scaling events ───────────────────────────
CREATE TABLE IF NOT EXISTS "runtime_nodes" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "region"         text NOT NULL,
  "role"           text NOT NULL,        -- api | worker | research | image | browser
  "status"         text NOT NULL DEFAULT 'healthy', -- healthy | degraded | down | isolated
  "capacity"       integer NOT NULL DEFAULT 1,
  "active_load"    integer NOT NULL DEFAULT 0,
  "queue_depth"    integer NOT NULL DEFAULT 0,
  "endpoint"       text,
  "metadata"       jsonb NOT NULL DEFAULT '{}',
  "last_heartbeat_at" bigint NOT NULL,
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "rn_workspace_idx" ON "runtime_nodes" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rn_status_idx"    ON "runtime_nodes" ("status");
CREATE INDEX IF NOT EXISTS "rn_region_idx"    ON "runtime_nodes" ("region");

CREATE TABLE IF NOT EXISTS "scaling_events" (
  "id"           text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "kind"         text NOT NULL,    -- scale_up | scale_down | isolate | failover | reroute | throttle
  "target"       text NOT NULL,    -- queue/role/node identifier
  "before"       integer,
  "after"        integer,
  "reason"       text NOT NULL,
  "approved_by"  text,             -- 'auto' if autonomous; operator id otherwise
  "created_at"   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "se_workspace_idx" ON "scaling_events" ("workspace_id");
CREATE INDEX IF NOT EXISTS "se_kind_idx"      ON "scaling_events" ("kind");
CREATE INDEX IF NOT EXISTS "se_created_idx"   ON "scaling_events" ("created_at");

-- ─── 2. Identity profile + communication audit ──────────────────────────
CREATE TABLE IF NOT EXISTS "identity_profile" (
  "workspace_id"  text PRIMARY KEY,
  "traits"        jsonb NOT NULL DEFAULT '{}',     -- { calm: 0.9, tactical: 0.85, ... }
  "tone_settings" jsonb NOT NULL DEFAULT '{}',     -- operator overrides
  "version"       integer NOT NULL DEFAULT 1,
  "updated_at"    bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "communication_audit" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "source"        text NOT NULL,         -- agent name producing the text
  "output_type"   text NOT NULL,         -- incident | brief | research | patch | risk | rec | social | support
  "text"          text NOT NULL,
  "hype_score"    real NOT NULL DEFAULT 0,
  "uncertainty_handling" text NOT NULL,  -- explicit | implicit | missing
  "fact_estimate_ok" boolean NOT NULL DEFAULT true,
  "violations"    jsonb NOT NULL DEFAULT '[]',
  "passed"        boolean NOT NULL DEFAULT true,
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ca_workspace_idx" ON "communication_audit" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ca_source_idx"    ON "communication_audit" ("source");
CREATE INDEX IF NOT EXISTS "ca_created_idx"   ON "communication_audit" ("created_at");

-- ─── 3. Scenarios + simulation runs ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "scenarios" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "kind"           text NOT NULL,        -- provider_outage | queue_overload | deployment_failure | security_incident | budget_spike | traffic_surge | scaling | operator_growth | marketplace_risk | social_strategy
  "name"           text NOT NULL,
  "inputs"         jsonb NOT NULL DEFAULT '{}',
  "best_case"      jsonb NOT NULL DEFAULT '{}',
  "likely_case"    jsonb NOT NULL DEFAULT '{}',
  "worst_case"     jsonb NOT NULL DEFAULT '{}',
  "confidence"     real NOT NULL DEFAULT 0,
  "mitigation"     jsonb NOT NULL DEFAULT '[]',
  "evidence_refs"  jsonb NOT NULL DEFAULT '[]',
  "created_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sc_workspace_idx" ON "scenarios" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sc_kind_idx"      ON "scenarios" ("kind");
CREATE INDEX IF NOT EXISTS "sc_created_idx"   ON "scenarios" ("created_at");

CREATE TABLE IF NOT EXISTS "scenario_outcomes" (
  "id"            text PRIMARY KEY,
  "scenario_id"   text NOT NULL,
  "workspace_id"  text NOT NULL,
  "observed"      jsonb NOT NULL DEFAULT '{}',
  "matched_case"  text,                -- best | likely | worst | none
  "delta"         jsonb NOT NULL DEFAULT '{}',
  "observed_at"   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "so_scenario_idx" ON "scenario_outcomes" ("scenario_id");
CREATE INDEX IF NOT EXISTS "so_workspace_idx" ON "scenario_outcomes" ("workspace_id");
