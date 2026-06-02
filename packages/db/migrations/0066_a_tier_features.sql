-- R146.136 — A-tier features 6-10

CREATE TABLE IF NOT EXISTS distillation_datasets (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,             -- 'proposals' | 'decisions' | 'rejections' | 'patches'
  sample_count    INTEGER NOT NULL DEFAULT 0,
  jsonl_path      TEXT,                       -- path to assembled .jsonl on disk
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS dd_ws_idx ON distillation_datasets(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reality_diffs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  source          TEXT NOT NULL,             -- 'instagram' | 'youtube' | 'tiktok' | 'stripe' | 'shopify'
  expected        JSONB NOT NULL DEFAULT '{}'::jsonb,    -- DB state
  actual          JSONB NOT NULL DEFAULT '{}'::jsonb,    -- API state
  divergence      REAL NOT NULL DEFAULT 0,   -- 0..1
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  observed_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rd_ws_idx ON reality_diffs(workspace_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS rd_open_idx ON reality_diffs(workspace_id, resolved);

CREATE TABLE IF NOT EXISTS anomaly_hypotheses (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  metric          TEXT NOT NULL,
  observed_value  REAL NOT NULL,
  expected_value  REAL NOT NULL,
  hypotheses      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name, prior, costToVerify, status}]
  status          TEXT NOT NULL DEFAULT 'open',
  investigated_first TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ah_ws_idx ON anomaly_hypotheses(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sponsorship_outreach (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  channel_id      TEXT,                       -- which of your channels is the sponsorable asset
  prospect_brand  TEXT NOT NULL,
  audience_overlap REAL NOT NULL DEFAULT 0,
  draft_dm        TEXT,
  rate_proposed   REAL,
  status          TEXT NOT NULL DEFAULT 'drafted',  -- drafted | sent | replied | declined | won
  sent_at         BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS so_ws_idx ON sponsorship_outreach(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_docs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  doc_kind        TEXT NOT NULL,             -- 'architecture' | 'ops_index' | 'runbook'
  body_md         TEXT NOT NULL,
  generated_from  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of sources sampled
  superseded_by   TEXT,                       -- id of newer version
  generated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_ws_kind_idx ON auto_docs(workspace_id, doc_kind, generated_at DESC);
