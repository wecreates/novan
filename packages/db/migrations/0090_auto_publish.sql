-- R146.167 — Auto-publish pipeline: PAI run → bandit-picked caption →
-- one socialPost per active platform → optional auto-repurpose.

CREATE TABLE IF NOT EXISTS publish_plan (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  run_id        text NOT NULL,
  source_kind   text NOT NULL DEFAULT 'pai_run',  -- pai_run | manual
  platforms     jsonb NOT NULL DEFAULT '[]',       -- ['youtube','tiktok','instagram','x']
  asset_paths   jsonb NOT NULL DEFAULT '[]',
  social_post_ids jsonb NOT NULL DEFAULT '[]',
  repurpose_pack_id text,
  scheduled_at  bigint,
  status        text NOT NULL DEFAULT 'draft',     -- draft | scheduled | publishing | published | failed
  error         text,
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pp_run_idx ON publish_plan(run_id);
CREATE INDEX IF NOT EXISTS pp_ws_idx ON publish_plan(workspace_id, status, created_at DESC);
