-- R146.164 — Funnel CRO: event tracking + multi-armed bandit + cart recovery.

CREATE TABLE IF NOT EXISTS funnel_event (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  session_id    text NOT NULL,
  kind          text NOT NULL,             -- view | click | signup | purchase | custom
  source        text,                       -- utm_source or referrer
  medium        text,
  campaign      text,
  page          text,
  ref           text,
  amount_cents  integer,
  meta          jsonb NOT NULL DEFAULT '{}',
  capture_id    text,                       -- ties to lead_capture if email known
  at            bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS fe_ws_idx ON funnel_event(workspace_id, at DESC);
CREATE INDEX IF NOT EXISTS fe_session_idx ON funnel_event(session_id, at);
CREATE INDEX IF NOT EXISTS fe_kind_idx ON funnel_event(workspace_id, kind, at DESC);

CREATE TABLE IF NOT EXISTS funnel_session (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  business_id     text,
  first_touch_at  bigint NOT NULL,
  last_touch_at   bigint NOT NULL,
  first_source    text,
  first_campaign  text,
  capture_id      text,
  purchased       boolean NOT NULL DEFAULT false,
  revenue_cents   integer NOT NULL DEFAULT 0,
  view_count      integer NOT NULL DEFAULT 0,
  click_count     integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS fs_ws_idx ON funnel_session(workspace_id, last_touch_at DESC);
CREATE INDEX IF NOT EXISTS fs_purchased_idx ON funnel_session(workspace_id, purchased, last_touch_at DESC);

CREATE TABLE IF NOT EXISTS bandit_experiment (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  name          text NOT NULL,
  variants      jsonb NOT NULL DEFAULT '[]', -- [{ id, label, alpha, beta, impressions, conversions }]
  status        text NOT NULL DEFAULT 'running', -- running | paused | concluded
  created_at    bigint NOT NULL,
  concluded_at  bigint,
  winner        text
);
CREATE UNIQUE INDEX IF NOT EXISTS be_ws_name_idx ON bandit_experiment(workspace_id, name);
CREATE INDEX IF NOT EXISTS be_ws_status_idx ON bandit_experiment(workspace_id, status);

CREATE TABLE IF NOT EXISTS cart_abandonment (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  session_id    text,
  email         text,
  cart_value_cents integer NOT NULL DEFAULT 0,
  items         jsonb NOT NULL DEFAULT '[]',
  abandoned_at  bigint NOT NULL,
  recovered_at  bigint,
  recovery_campaign_id text,
  recovery_status text NOT NULL DEFAULT 'pending' -- pending | recovered | drafted | sent | expired
);
CREATE INDEX IF NOT EXISTS ca_ws_idx ON cart_abandonment(workspace_id, abandoned_at DESC);
CREATE INDEX IF NOT EXISTS ca_status_idx ON cart_abandonment(workspace_id, recovery_status, abandoned_at);
