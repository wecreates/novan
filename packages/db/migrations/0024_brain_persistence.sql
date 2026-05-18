-- 0024_brain_persistence.sql
-- Saved views (synced across devices) + status history for replay fidelity.

CREATE TABLE IF NOT EXISTS "saved_views" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "operator_id"     text,
  "name"            text NOT NULL,
  "template"        text NOT NULL,
  "focus_system"    text,
  "camera_position" jsonb,
  "lod"             text NOT NULL DEFAULT 'systems',
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sv_workspace_idx" ON "saved_views" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sv_updated_idx"   ON "saved_views" ("updated_at");

CREATE TABLE IF NOT EXISTS "status_changes" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "entity_type"   text NOT NULL,   -- agent | proposal | drift | kill_switch | provider
  "entity_id"     text NOT NULL,
  "status"        text NOT NULL,
  "source"        text NOT NULL,   -- which service wrote it
  "changed_at"    bigint NOT NULL,
  "metadata"      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "sch_workspace_idx" ON "status_changes" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sch_entity_idx"    ON "status_changes" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "sch_changed_idx"   ON "status_changes" ("changed_at");
