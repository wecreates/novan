-- R146.162 — Owned-audience loop: lead magnets + email list + campaigns.
-- The single biggest jump from $0 → $10k/mo: own the audience, don't rent it.

CREATE TABLE IF NOT EXISTS lead_magnet (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text,
  title         text NOT NULL,
  slug          text NOT NULL,
  format        text NOT NULL DEFAULT 'pdf',  -- pdf | checklist | template | swipe | course
  body          text NOT NULL,                -- the magnet content
  file_url      text,                         -- optional CDN url
  signups       integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'active',
  created_at    bigint NOT NULL,
  archived_at   bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS lm_ws_slug_idx ON lead_magnet(workspace_id, slug);
CREATE INDEX IF NOT EXISTS lm_ws_idx ON lead_magnet(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_capture (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  magnet_id       text,
  email           text NOT NULL,
  name            text,
  source          text NOT NULL DEFAULT 'page', -- page | comment | dm | post | manual | import
  source_ref      text,
  segments        jsonb NOT NULL DEFAULT '[]',
  subscribed_at   bigint NOT NULL,
  unsubscribed_at bigint,
  last_open_at    bigint,
  last_click_at   bigint,
  bounce_count    integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS lc_ws_email_idx ON lead_capture(workspace_id, email);
CREATE INDEX IF NOT EXISTS lc_ws_subscribed_idx ON lead_capture(workspace_id, subscribed_at);
CREATE INDEX IF NOT EXISTS lc_ws_segments_idx ON lead_capture(workspace_id, last_open_at);

CREATE TABLE IF NOT EXISTS email_campaign (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  name            text NOT NULL,
  subject_a       text NOT NULL,
  subject_b       text,
  body            text NOT NULL,
  segment_filter  jsonb NOT NULL DEFAULT '{}',
  from_address    text,
  from_name       text,
  reply_to        text,
  scheduled_at    bigint,
  sent_at         bigint,
  status          text NOT NULL DEFAULT 'draft', -- draft | scheduled | sending | sent | failed
  sends           integer NOT NULL DEFAULT 0,
  opens           integer NOT NULL DEFAULT 0,
  clicks          integer NOT NULL DEFAULT 0,
  bounces         integer NOT NULL DEFAULT 0,
  winner_variant  text,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ec_ws_idx ON email_campaign(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ec_scheduled_idx ON email_campaign(status, scheduled_at);

CREATE TABLE IF NOT EXISTS email_send (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  campaign_id   text NOT NULL,
  capture_id    text NOT NULL,
  variant       text NOT NULL DEFAULT 'a',  -- a | b
  provider      text NOT NULL DEFAULT 'resend',
  provider_id   text,
  sent_at       bigint NOT NULL,
  opened_at     bigint,
  clicked_at    bigint,
  bounced_at    bigint,
  error         text
);
CREATE INDEX IF NOT EXISTS es_campaign_idx ON email_send(campaign_id, sent_at);
CREATE INDEX IF NOT EXISTS es_capture_idx ON email_send(capture_id, sent_at);
