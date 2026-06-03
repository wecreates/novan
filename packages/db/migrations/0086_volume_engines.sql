-- R146.163 — Volume engines: repurpose + trend-to-publish + competitor watch.
-- One source-of-truth → N platform-specific variants. Compounds existing
-- production by 5-10x without new ideation.

CREATE TABLE IF NOT EXISTS repurpose_pack (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  source_kind   text NOT NULL DEFAULT 'text', -- text | video_transcript | blog | email
  source_ref    text,                          -- pointer if from another table
  source_body   text NOT NULL,
  title         text,
  variant_count integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'ready', -- draft | ready | published | archived
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rp_ws_idx ON repurpose_pack(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS repurpose_variant (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  pack_id       text NOT NULL,
  format        text NOT NULL,                 -- tweet | short_hook | blog_section | email_subject | ig_caption | thread | yt_title
  body          text NOT NULL,
  score         real,
  used_at       bigint,
  published_external_id text,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rv_pack_idx ON repurpose_variant(pack_id);
CREATE INDEX IF NOT EXISTS rv_ws_format_idx ON repurpose_variant(workspace_id, format, created_at DESC);

CREATE TABLE IF NOT EXISTS competitor_handle (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  platform      text NOT NULL,                 -- youtube | tiktok | instagram | x | other
  handle        text NOT NULL,
  niche         text,
  notes         text,
  status        text NOT NULL DEFAULT 'active',
  added_at      bigint NOT NULL,
  last_scanned_at bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS ch_ws_platform_handle_idx ON competitor_handle(workspace_id, platform, handle);
CREATE INDEX IF NOT EXISTS ch_ws_idx ON competitor_handle(workspace_id, status);

CREATE TABLE IF NOT EXISTS competitor_winner (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  competitor_id text NOT NULL,
  external_id   text,
  body          text NOT NULL,
  metric_score  real,
  theme         text,
  recorded_at   bigint NOT NULL,
  source        text NOT NULL DEFAULT 'agent'  -- agent | operator | scrape
);
CREATE INDEX IF NOT EXISTS cw_ws_idx ON competitor_winner(workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS cw_comp_idx ON competitor_winner(competitor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS cw_theme_idx ON competitor_winner(workspace_id, theme);
