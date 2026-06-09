-- R534 — consolidate runtime tables created ad-hoc by services R506/R509/R510/R516/R517/R521.
-- These were previously CREATE TABLE IF NOT EXISTS inside service files which works
-- but leaves Drizzle blind to them (no rollback safety, no type-safe queries, no
-- schema-drift detection). This migration is idempotent — won't conflict with
-- existing tables created by service ensureTable() calls.

-- R506 — per-platform session last-success timestamps
CREATE TABLE IF NOT EXISTS platform_sessions (
  workspace_id   TEXT NOT NULL,
  platform       TEXT NOT NULL,
  last_ok_at     BIGINT NOT NULL,
  last_kind      TEXT,
  PRIMARY KEY (workspace_id, platform)
);

-- R509 — image-gen provider health history (fal/replicate/stability/openai)
-- R560 — column name must match what r509 ensureTable() creates: last_probed_at
CREATE TABLE IF NOT EXISTS image_provider_health (
  provider          TEXT PRIMARY KEY,
  last_status       TEXT NOT NULL,           -- 'ok' | 'down' | 'unconfigured' | 'degraded'
  last_latency_ms   INT,
  consecutive_fails INT NOT NULL DEFAULT 0,
  last_error        TEXT,
  last_probed_at    BIGINT NOT NULL
);

-- R510 — 1099-K threshold notification dedup
-- R545 — matches what R510 ensureTable() actually creates (year/notified_at/ytd_at_notify),
-- not the speculative tax_year/fired_at the migration was first written with.
CREATE TABLE IF NOT EXISTS tax_threshold_notifications (
  workspace_id   TEXT NOT NULL,
  year           INTEGER NOT NULL,
  source         TEXT NOT NULL,
  bucket         TEXT NOT NULL,         -- '80pct' | '100pct'
  notified_at    BIGINT NOT NULL,
  ytd_at_notify  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (workspace_id, year, source, bucket)
);

-- R516 — DMCA claim records
CREATE TABLE IF NOT EXISTS dmca_claims (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  offending_url       TEXT NOT NULL,
  original_design_id  TEXT,
  platform            TEXT,
  status              TEXT NOT NULL DEFAULT 'drafted',
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS dmca_claims_ws_created_idx ON dmca_claims (workspace_id, created_at DESC);

-- R517 — opted-in buyer emails
CREATE TABLE IF NOT EXISTS buyer_emails (
  workspace_id  TEXT NOT NULL,
  email         TEXT NOT NULL,
  source        TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  sale_count    INT NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS buyer_emails_ws_last_idx ON buyer_emails (workspace_id, last_seen_at DESC);

-- R521 — price-experiment Thompson sampler stats
CREATE TABLE IF NOT EXISTS price_experiments (
  workspace_id TEXT NOT NULL,
  product_key  TEXT NOT NULL,
  price_cents  INT  NOT NULL,
  views        INT  NOT NULL DEFAULT 0,
  sales        INT  NOT NULL DEFAULT 0,
  last_used_at BIGINT,
  PRIMARY KEY (workspace_id, product_key, price_cents)
);
