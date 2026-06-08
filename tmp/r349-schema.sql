-- R349 — Design factory + upload queue tables

CREATE TABLE IF NOT EXISTS design_catalog (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  niche           TEXT NOT NULL,           -- botanical, nautical, vintage_map, woodblock, etc
  style           TEXT NOT NULL,           -- watercolor, line_art, etched, ink_wash, etc
  prompt          TEXT NOT NULL,
  image_url       TEXT NOT NULL,            -- data:image or http URL
  source          TEXT NOT NULL,            -- 'ai_gen' | 'public_domain' | 'operator_upload'
  source_provider TEXT,                     -- 'huggingface', 'met_museum', etc
  parent_design_id TEXT,                    -- if this is a variant
  variant_type    TEXT,                     -- 'color_shift', 'crop', 'reframe', null for original
  quality_score   INTEGER NOT NULL DEFAULT 70,  -- 0-100 operator/auto rating
  is_live_count   INTEGER NOT NULL DEFAULT 0,   -- on how many platforms
  created_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS dc_workspace_niche ON design_catalog(workspace_id, niche);
CREATE INDEX IF NOT EXISTS dc_workspace_created ON design_catalog(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS design_upload_queue (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  design_id       TEXT NOT NULL,
  platform        TEXT NOT NULL,           -- 'gumroad', 'inprnt', 'fine_art_america', etc
  status          TEXT NOT NULL,           -- 'queued' | 'uploaded' | 'skipped' | 'failed'
  priority        INTEGER NOT NULL DEFAULT 50,  -- higher = upload sooner
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  tags            TEXT NOT NULL,           -- comma-separated
  price_usd       NUMERIC(10, 2),
  category        TEXT,
  queued_at       BIGINT NOT NULL,
  uploaded_at     BIGINT,
  external_url    TEXT,                     -- the live URL after operator confirms upload
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS duq_workspace_platform_status ON design_upload_queue(workspace_id, platform, status);
CREATE INDEX IF NOT EXISTS duq_workspace_status ON design_upload_queue(workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS duq_unique_design_platform ON design_upload_queue(workspace_id, design_id, platform);
