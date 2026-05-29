-- 0041_business_construction.sql
-- Live business construction primitives.
--
-- Two additions:
--   1. `businesses.dna` jsonb — strategic identity (mission, brand,
--      audience, monetization, growth) so the brain can spawn related
--      systems without re-eliciting context each time.
--   2. `business_systems` — the spatial children of a business. Each
--      row = one department, workflow, agent slot, asset pipeline, or
--      analytics surface. Together they form the operational graph the
--      brain renders as nodes.

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "dna"        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "vision"     text,
  ADD COLUMN IF NOT EXISTS "brief"      text;

CREATE TABLE IF NOT EXISTS "business_systems" (
  "id"               text PRIMARY KEY,
  "workspace_id"     text NOT NULL,
  "business_id"      text NOT NULL,
  "kind"             text NOT NULL,
  -- 'department' | 'workflow' | 'agent_slot' | 'asset' | 'analytics' | 'integration'
  "layer"            text NOT NULL,
  -- 'executive' | 'operations' | 'finance' | 'creative' | 'growth' | 'intelligence' | 'security'
  "name"             text NOT NULL,
  "summary"          text,
  "status"           text NOT NULL DEFAULT 'forming',
  -- 'forming' | 'active' | 'paused' | 'archived'
  "agent_slug"       text,
  -- Optional reference into agent_definitions.slug for delegation
  "parent_id"        text,
  -- For workflow/asset nodes that belong to a department
  "position"         jsonb,
  -- Optional spatial hint { x, y, z } picked up by the brain renderer
  "metadata"         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  "created_at"       bigint NOT NULL,
  "updated_at"       bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "biz_sys_ws_idx"       ON "business_systems" ("workspace_id");
CREATE INDEX IF NOT EXISTS "biz_sys_business_idx" ON "business_systems" ("business_id");
CREATE INDEX IF NOT EXISTS "biz_sys_kind_idx"     ON "business_systems" ("kind");
CREATE INDEX IF NOT EXISTS "biz_sys_parent_idx"   ON "business_systems" ("parent_id");
