-- R146.175 — Top-tier image generation + upscaling for crystal-clear results.

CREATE TABLE IF NOT EXISTS image_pro_job (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  prompt          text NOT NULL,
  negative_prompt text,
  provider        text NOT NULL,                  -- flux_pro_ultra | mj_v7 | recraft_v3 | imagen_4 | ideogram_v3
  aspect          text NOT NULL DEFAULT '1:1',
  megapixels      real NOT NULL DEFAULT 1.0,
  seed            bigint,
  reference_urls  jsonb NOT NULL DEFAULT '[]',
  params          jsonb NOT NULL DEFAULT '{}',
  output_url      text,
  width           integer,
  height          integer,
  cost_usd        real NOT NULL DEFAULT 0,
  latency_ms      integer,
  status          text NOT NULL DEFAULT 'queued',
  error           text,
  created_at      bigint NOT NULL,
  ended_at        bigint
);
CREATE INDEX IF NOT EXISTS ipj_ws_idx ON image_pro_job(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ipj_status_idx ON image_pro_job(workspace_id, status);

CREATE TABLE IF NOT EXISTS image_upscale_job (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  input_url       text NOT NULL,
  output_url      text,
  scale_factor    integer NOT NULL DEFAULT 4,
  provider        text NOT NULL DEFAULT 'clarity', -- clarity | topaz | magnific | upscayl | esrgan
  detail          real NOT NULL DEFAULT 0.5,        -- 0..1 detail enhancement
  cost_usd        real NOT NULL DEFAULT 0,
  width_in        integer,
  height_in       integer,
  width_out       integer,
  height_out      integer,
  status          text NOT NULL DEFAULT 'queued',
  error           text,
  created_at      bigint NOT NULL,
  ended_at        bigint
);
CREATE INDEX IF NOT EXISTS iuj_ws_idx ON image_upscale_job(workspace_id, created_at DESC);
