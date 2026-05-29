-- 0047_business_attachments.sql
--
-- Links concrete revenue sources (YouTube channels, Etsy shops, TikTok
-- accounts, newsletters, Stripe products) to a business row so the
-- portfolio system can auto-roll-up revenue + performance signals
-- without the operator having to manually record every event.
--
-- A business owns 0..N attachments. An attachment is owned by exactly
-- one business at a time. The (workspace, business, source, source_ref)
-- composite is unique so re-attaching the same channel is idempotent.
--
-- Reversible: DROP TABLE business_attachments;

CREATE TABLE IF NOT EXISTS business_attachments (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  business_id   text NOT NULL,
  -- Which platform / external source this attachment represents.
  -- youtube_channel | etsy_shop | tiktok_account | instagram_account |
  -- newsletter | stripe_product | shopify_store | other
  source        text NOT NULL,
  -- The platform's stable identifier (channel UC-id, Etsy shop id,
  -- Stripe product id, etc.). NEVER the human-readable name — names
  -- change but ids don't.
  source_ref    text NOT NULL,
  -- Optional friendly label the operator sees in the dashboard.
  label         text,
  enabled       boolean NOT NULL DEFAULT true,
  attached_at   bigint NOT NULL,
  -- When the brain last pulled performance / revenue for this attachment.
  -- Lets the analytics rollup skip recently-checked attachments.
  last_synced_at bigint,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bizattach_ws_biz_src_ref_uq
  ON business_attachments (workspace_id, business_id, source, source_ref);
CREATE INDEX IF NOT EXISTS bizattach_ws_idx       ON business_attachments (workspace_id);
CREATE INDEX IF NOT EXISTS bizattach_biz_idx      ON business_attachments (business_id);
CREATE INDEX IF NOT EXISTS bizattach_src_ref_idx  ON business_attachments (source, source_ref);
