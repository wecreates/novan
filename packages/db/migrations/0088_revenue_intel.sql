-- R146.165 — Revenue intelligence: SEO + LTV + cross-business + refund mining.

CREATE TABLE IF NOT EXISTS seo_article (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  query         text NOT NULL,            -- buyer-intent query targeted
  title         text NOT NULL,
  slug          text NOT NULL,
  body          text NOT NULL,
  meta_desc     text,
  intent        text NOT NULL DEFAULT 'commercial', -- informational | commercial | transactional
  status        text NOT NULL DEFAULT 'draft',     -- draft | published | archived
  views         integer NOT NULL DEFAULT 0,
  clicks        integer NOT NULL DEFAULT 0,
  conversions   integer NOT NULL DEFAULT 0,
  published_at  bigint,
  created_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sa_ws_slug_idx ON seo_article(workspace_id, slug);
CREATE INDEX IF NOT EXISTS sa_ws_idx ON seo_article(workspace_id, status, published_at DESC);

CREATE TABLE IF NOT EXISTS customer_score (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  customer_ref    text NOT NULL,           -- email or external customer id
  revenue_cents   integer NOT NULL DEFAULT 0,
  predicted_ltv_cents integer NOT NULL DEFAULT 0,
  decile          integer NOT NULL DEFAULT 5,  -- 1=lowest, 10=whale
  signals         jsonb NOT NULL DEFAULT '{}',
  last_purchase_at bigint,
  first_seen_at   bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cs_ws_ref_idx ON customer_score(workspace_id, customer_ref);
CREATE INDEX IF NOT EXISTS cs_ws_decile_idx ON customer_score(workspace_id, decile);

CREATE TABLE IF NOT EXISTS cross_business_overlap (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_a      text NOT NULL,
  business_b      text NOT NULL,
  shared_customers integer NOT NULL DEFAULT 0,
  total_a         integer NOT NULL DEFAULT 0,
  total_b         integer NOT NULL DEFAULT 0,
  overlap_pct     real NOT NULL DEFAULT 0,
  computed_at     bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cbo_ws_pair_idx ON cross_business_overlap(workspace_id, business_a, business_b);

CREATE TABLE IF NOT EXISTS refund_reason (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  order_ref     text,
  customer_ref  text,
  reason_text   text NOT NULL,
  category      text,                       -- product_defect | shipping | expectation | sizing | duplicate | other
  amount_cents  integer NOT NULL DEFAULT 0,
  recorded_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS rr_ws_idx ON refund_reason(workspace_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS rr_ws_cat_idx ON refund_reason(workspace_id, category);
