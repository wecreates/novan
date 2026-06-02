-- 0053 — Frontier MAX (R146.107)
-- Capability catalog + permanent advancement loop + MAX-mode settings.

CREATE TABLE IF NOT EXISTS "frontier_capabilities" (
  "id"                    text PRIMARY KEY NOT NULL,
  "workspace_id"          text NOT NULL,
  "name"                  text NOT NULL,
  "category"              text NOT NULL,
  "status"                text NOT NULL DEFAULT 'unknown',
  "description"           text,
  "upstream_finding_ids"  jsonb,
  "integration_path"      text,
  "current_version"       integer NOT NULL DEFAULT 0,
  "realism_score"         integer NOT NULL DEFAULT 0,
  "quality_score"         integer NOT NULL DEFAULT 0,
  "efficiency_score"      integer NOT NULL DEFAULT 0,
  "last_advanced_at"      bigint,
  "advancement_count"     integer NOT NULL DEFAULT 0,
  "created_at"            bigint NOT NULL,
  "updated_at"            bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "frontier_capabilities_ws_name_idx"
  ON "frontier_capabilities" ("workspace_id", "name");
CREATE INDEX IF NOT EXISTS "frontier_capabilities_ws_status_idx"
  ON "frontier_capabilities" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "frontier_capabilities_ws_cat_idx"
  ON "frontier_capabilities" ("workspace_id", "category");

CREATE TABLE IF NOT EXISTS "frontier_advancements" (
  "id"                 text PRIMARY KEY NOT NULL,
  "workspace_id"       text NOT NULL,
  "capability_id"      text NOT NULL,
  "proposed_at"        bigint NOT NULL,
  "kind"               text NOT NULL,
  "proposal"           text,
  "expected_gain"      integer NOT NULL DEFAULT 0,
  "applied_at"         bigint,
  "applied_notes"      text,
  "realism_before"     integer,
  "realism_after"      integer,
  "quality_before"     integer,
  "quality_after"      integer,
  "efficiency_before"  integer,
  "efficiency_after"   integer
);
CREATE INDEX IF NOT EXISTS "frontier_advancements_ws_cap_idx"
  ON "frontier_advancements" ("workspace_id", "capability_id", "proposed_at");

CREATE TABLE IF NOT EXISTS "frontier_settings" (
  "workspace_id"          text PRIMARY KEY NOT NULL,
  "max_mode"              boolean NOT NULL DEFAULT false,
  "scan_interval_ms"      integer NOT NULL DEFAULT 300000,
  "distill_batch_size"    integer NOT NULL DEFAULT 8,
  "prototype_batch_size"  integer NOT NULL DEFAULT 3,
  "advance_batch_size"    integer NOT NULL DEFAULT 3,
  "parallel_sources"      integer NOT NULL DEFAULT 3,
  "updated_at"            bigint NOT NULL
);
