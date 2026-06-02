-- R146.134 — POD mass production runs

CREATE TABLE IF NOT EXISTS pod_batch_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  niche           TEXT NOT NULL,
  design_style    TEXT NOT NULL DEFAULT 'modern minimal',
  target_count    INTEGER NOT NULL DEFAULT 20,
  product_types   JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ['tshirt', 'poster', 'mug', 'tote', 'hoodie']
  stores          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ['printful', 'shopify', 'etsy']
  status          TEXT NOT NULL DEFAULT 'running',      -- running | completed | halted | failed
  generated_count INTEGER NOT NULL DEFAULT 0,
  listed_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  total_cost_usd  REAL NOT NULL DEFAULT 0,
  halt_reason     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pbr_ws_idx     ON pod_batch_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS pbr_status_idx ON pod_batch_runs(workspace_id, status);

CREATE TABLE IF NOT EXISTS pod_batch_items (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  design_prompt   TEXT NOT NULL,
  product_type    TEXT NOT NULL,
  image_url       TEXT,
  image_gen_id    TEXT,
  title           TEXT,
  description     TEXT,
  listed_stores   JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{store, productId, listedAt}]
  status          TEXT NOT NULL DEFAULT 'queued',       -- queued | image_done | listed | failed
  error           TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pbi_batch_idx  ON pod_batch_items(batch_id, status);
CREATE INDEX IF NOT EXISTS pbi_ws_idx     ON pod_batch_items(workspace_id, created_at DESC);
