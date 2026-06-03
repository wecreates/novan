-- R146.179 — POD stores driven entirely by organic social traffic.
-- No paid ads. Stores ↔ social posts via UTM-stitched funnel routes.

CREATE TABLE IF NOT EXISTS pod_store (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  platform      text NOT NULL,                  -- shopify | etsy | printful | redbubble | gumroad
  domain        text,                            -- custom domain or platform url
  niche         text,
  brand_name    text NOT NULL,
  social_account_ids jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'active',
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ps_ws_idx ON pod_store(workspace_id, status);

CREATE TABLE IF NOT EXISTS pod_product (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  store_id        text NOT NULL,
  sku             text NOT NULL,
  title           text NOT NULL,
  design_url      text,
  category        text,
  tags            jsonb NOT NULL DEFAULT '[]',
  price_cents     integer NOT NULL DEFAULT 0,
  cost_cents      integer NOT NULL DEFAULT 0,
  margin_cents   integer NOT NULL DEFAULT 0,
  external_id     text,
  product_url     text,
  sold_count      integer NOT NULL DEFAULT 0,
  revenue_cents   integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'active',
  listed_at       bigint,
  created_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pp_store_sku_idx ON pod_product(store_id, sku);
CREATE INDEX IF NOT EXISTS pp_ws_revenue_idx ON pod_product(workspace_id, revenue_cents DESC);

CREATE TABLE IF NOT EXISTS social_funnel_route (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  social_post_id  text NOT NULL,
  store_id        text NOT NULL,
  product_id      text,
  utm_campaign    text NOT NULL,
  utm_source      text,
  utm_medium      text,
  short_url       text,
  clicks          integer NOT NULL DEFAULT 0,
  conversions     integer NOT NULL DEFAULT 0,
  revenue_cents   integer NOT NULL DEFAULT 0,
  created_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sfr_post_store_idx ON social_funnel_route(social_post_id, store_id);
CREATE INDEX IF NOT EXISTS sfr_ws_idx ON social_funnel_route(workspace_id, created_at DESC);
