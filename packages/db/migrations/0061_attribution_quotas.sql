-- R146.131 — Tier 2 batch 2: platform quotas + revenue attribution edges

CREATE TABLE IF NOT EXISTS platform_quota_usage (
  workspace_id    TEXT NOT NULL,
  platform        TEXT NOT NULL,        -- 'instagram' | 'youtube' | 'tiktok' | 'shopify' | 'etsy' | 'printful'
  bucket_day      TEXT NOT NULL,        -- 'YYYY-MM-DD' UTC
  action          TEXT NOT NULL,        -- 'post' | 'api_call' | 'upload'
  count           INTEGER NOT NULL DEFAULT 0,
  daily_cap       INTEGER NOT NULL DEFAULT 25,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, platform, bucket_day, action)
);
CREATE INDEX IF NOT EXISTS pqu_ws_day_idx ON platform_quota_usage(workspace_id, bucket_day);

CREATE TABLE IF NOT EXISTS attribution_edges (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  src_type        TEXT NOT NULL,        -- 'clip' | 'post' | 'channel' | 'business' | 'product' | 'sale'
  src_id          TEXT NOT NULL,
  dst_type        TEXT NOT NULL,
  dst_id          TEXT NOT NULL,
  relation        TEXT NOT NULL,        -- 'published_to' | 'belongs_to' | 'sold_via' | 'attributed_to'
  weight          REAL NOT NULL DEFAULT 1.0,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ae_src_idx ON attribution_edges(workspace_id, src_type, src_id);
CREATE INDEX IF NOT EXISTS ae_dst_idx ON attribution_edges(workspace_id, dst_type, dst_id);
CREATE INDEX IF NOT EXISTS ae_rel_idx ON attribution_edges(workspace_id, relation);
