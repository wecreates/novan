-- 0046_business_portfolio.sql
--
-- Extends the existing `businesses` table from migration 0041 with the
-- portfolio-tracking primitives needed to track each business against
-- the $10k/mo per-business floor:
--
--   • business_revenue  — append-only ledger of every $ event tied back
--                         to a business + earnings month
--   • business_prompts  — versioned, score-tracked prompts the brain
--                         rotates through (the self-evolving layer)
--
-- The $10k/mo target itself lives in businesses.metrics JSONB under
-- `monthlyTargetUsd` (defaulted to 10000 by services/business-portfolio.ts)
-- — no schema migration needed for the target value itself.
--
-- Reversible — drop in reverse order:
--   DROP TABLE business_revenue;
--   DROP TABLE business_prompts;

-- Append-only revenue ledger. Every recorded sale / view-bucket / payout
-- gets one row. The brain aggregates on read.
CREATE TABLE IF NOT EXISTS business_revenue (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL,
  business_id      text NOT NULL,
  -- ad_share | sale | sponsorship | affiliate | tip | refund | other
  kind             text NOT NULL,
  amount_usd_cents bigint NOT NULL,   -- store cents; negative for refunds
  -- source_ref points back to the originating row (youtube_video.id,
  -- etsy_order.id, etc.) so the brain can correlate revenue to content.
  source           text,
  source_ref       text,
  -- The "earnings month" the operator should reconcile this against.
  -- YouTube pays for May at the end of July; the operator-facing month
  -- of record is May, not July.
  earnings_month   text NOT NULL,   -- 'YYYY-MM'
  -- When the revenue actually landed in the operator's bank (or the
  -- platform's escrow). NULL if pending.
  landed_at        bigint,
  recorded_at      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS biz_rev_biz_month_idx ON business_revenue (business_id, earnings_month);
CREATE INDEX IF NOT EXISTS biz_rev_ws_idx        ON business_revenue (workspace_id, recorded_at DESC);


-- Versioned prompts the brain uses for routine tasks (script-draft,
-- thumbnail-prompt, etc.). Each row is a version; the highest-scored
-- enabled version for a (workspace, slot) is the one the brain pulls
-- on its next call. See prompt-evolution.ts for the rotation logic.
CREATE TABLE IF NOT EXISTS business_prompts (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL,
  -- Logical slot — multiple versions live behind the same slot.
  -- Examples: 'script.draft', 'thumbnail.prompt', 'reply.youtube_comment',
  -- 'etsy.listing_description', 'tiktok.hook'.
  slot             text NOT NULL,
  version          integer NOT NULL,
  body             text NOT NULL,
  -- Outcome aggregates updated by the cron — number of uses, average
  -- downstream success score (CTR / engagement / conversion depending
  -- on slot), and the most recent score.
  uses             integer NOT NULL DEFAULT 0,
  score_sum        real NOT NULL DEFAULT 0,
  last_score       real,
  last_used_at     bigint,
  enabled          boolean NOT NULL DEFAULT true,
  -- The id of the parent version this was mutated from. NULL for the
  -- seed version. Used to draw the evolution lineage.
  parent_id        text,
  -- Reason this version exists ('seed', 'manual_edit', 'auto_mutation',
  -- 'auto_promotion'). Audit trail for prompt provenance.
  origin           text NOT NULL DEFAULT 'seed',
  created_at       bigint NOT NULL,
  updated_at       bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS biz_prompt_ws_slot_idx ON business_prompts (workspace_id, slot, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS biz_prompt_ws_slot_version_uq
  ON business_prompts (workspace_id, slot, version);
