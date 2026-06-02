-- 0052 — Novan Frontier Intelligence (R146.105)
-- 24/7 AI breakthrough scanner + distiller + ledger. Powers Novan running
-- 6 months ahead of competitors by prototyping arxiv/HF/GitHub findings
-- before they get productized.

CREATE TABLE IF NOT EXISTS "frontier_sources" (
  "id"                 text PRIMARY KEY NOT NULL,
  "workspace_id"       text NOT NULL,
  "kind"               text NOT NULL,
  "url"                text NOT NULL,
  "label"              text NOT NULL,
  "enabled"            boolean NOT NULL DEFAULT true,
  "last_scanned_at"    bigint,
  "scan_interval_sec"  integer NOT NULL DEFAULT 3600,
  "created_at"         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "frontier_sources_ws_idx"
  ON "frontier_sources" ("workspace_id", "enabled");

CREATE TABLE IF NOT EXISTS "frontier_findings" (
  "id"                 text PRIMARY KEY NOT NULL,
  "workspace_id"       text NOT NULL,
  "source_id"          text,
  "external_url"       text NOT NULL,
  "external_id"        text,
  "title"              text NOT NULL,
  "authors"            text,
  "published_at"       bigint,
  "discovered_at"      bigint NOT NULL,
  "raw_abstract"       text,
  "technique"          text,
  "claimed_capability" text,
  "novelty_vs_sota"    text,
  "replicability_note" text,
  "integration_vector" text,
  "score_recency"        integer NOT NULL DEFAULT 0,
  "score_impact"         integer NOT NULL DEFAULT 0,
  "score_replicability"  integer NOT NULL DEFAULT 0,
  "score_applicability"  integer NOT NULL DEFAULT 0,
  "score_composite"      integer NOT NULL DEFAULT 0,
  "status"             text NOT NULL DEFAULT 'new',
  "prototype_task_id"  text,
  "integrated_at"      bigint,
  "rejected_reason"    text,
  "embedding"          vector(1536),
  "created_at"         bigint NOT NULL,
  "updated_at"         bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "frontier_findings_ws_status_idx"
  ON "frontier_findings" ("workspace_id", "status", "score_composite");
CREATE INDEX IF NOT EXISTS "frontier_findings_ws_pub_idx"
  ON "frontier_findings" ("workspace_id", "published_at");
CREATE UNIQUE INDEX IF NOT EXISTS "frontier_findings_ws_extid_idx"
  ON "frontier_findings" ("workspace_id", "external_id");

CREATE TABLE IF NOT EXISTS "frontier_advances" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "finding_id"   text NOT NULL,
  "ahead"        text NOT NULL,
  "months_ahead" real NOT NULL DEFAULT 0,
  "notes"        text,
  "recorded_at"  bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "frontier_advances_ws_idx"
  ON "frontier_advances" ("workspace_id", "recorded_at");
