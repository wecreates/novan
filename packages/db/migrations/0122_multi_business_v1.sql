-- R580 — Multi-business architecture foundation.
-- Operator goal: run 50+ businesses inside ONE workspace (shared operator
-- account, separate operational state per business).
--
-- This migration ADDS NULLABLE business_id columns to load-bearing tables
-- so existing rows continue working (NULL business_id == workspace-level /
-- operator-default). New code can scope via (workspace_id, business_id).
--
-- Idempotent: every ADD COLUMN is IF NOT EXISTS.

-- Brand profile per business (R571 extended)
ALTER TABLE brand_profile ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Buyer emails per business — different business may want different list
ALTER TABLE buyer_emails ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Per-business AI spend caps (R428/R524 extension)
ALTER TABLE ai_spend ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Per-business kill switches (R443 extension) — operator can pause one
-- business without pausing the others
ALTER TABLE kill_switches ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Price experiments scoped to business (R521 extension)
ALTER TABLE price_experiments ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Federation contributions tagged with business (R570 extension)
ALTER TABLE bandit_federation ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Email log per business — billing + analytics
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Tax thresholds per business — separate Schedule C filing
ALTER TABLE tax_threshold_notifications ADD COLUMN IF NOT EXISTS business_id TEXT;

-- DMCA claims per business
ALTER TABLE dmca_claims ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Hooks per business — operator can hook only one business's ops
ALTER TABLE operator_hooks ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Finance reserves are inherently per-source-per-business
ALTER TABLE finance_reserves ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE factoring_intents ADD COLUMN IF NOT EXISTS business_id TEXT;
ALTER TABLE insurance_enrollments ADD COLUMN IF NOT EXISTS business_id TEXT;

-- Composite indexes for the hottest scoped queries (each is partial — only
-- created when business_id is non-null so they don't bloat single-business
-- workspaces).
CREATE INDEX IF NOT EXISTS brand_profile_ws_biz_idx       ON brand_profile     (workspace_id, business_id) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS buyer_emails_ws_biz_idx        ON buyer_emails      (workspace_id, business_id) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_spend_ws_biz_day_idx        ON ai_spend          (workspace_id, business_id, day_yyyymmdd) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS kill_switches_ws_biz_idx       ON kill_switches     (workspace_id, business_id, switch_type) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS price_experiments_ws_biz_idx   ON price_experiments (workspace_id, business_id, product_key) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_log_ws_biz_sent_idx      ON email_log         (workspace_id, business_id, sent_at DESC) WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_reserves_ws_biz_idx    ON finance_reserves  (workspace_id, business_id, source) WHERE business_id IS NOT NULL;

-- Per-workspace setting: which business is the operator's "default" — used
-- when caller doesn't specify business_id. Lives in workspace_settings
-- (no migration needed; just convention).

-- Per-business budget caps live in workspace_settings keyed by
--   `${business_id}.daily_ai_budget_usd`
-- (no schema change needed; convention).
