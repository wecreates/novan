-- R381-R425 schema additions for Novan POD autonomous loop.
-- Idempotent. Run after the base schema is in place.
ALTER TABLE business_revenue ADD COLUMN IF NOT EXISTS external_sale_id TEXT;
ALTER TABLE business_revenue ADD COLUMN IF NOT EXISTS net_usd          DOUBLE PRECISION;
ALTER TABLE business_revenue ADD COLUMN IF NOT EXISTS gross_usd        DOUBLE PRECISION;
ALTER TABLE business_revenue ADD COLUMN IF NOT EXISTS metadata         JSONB;
ALTER TABLE business_revenue ADD COLUMN IF NOT EXISTS currency         TEXT;
ALTER TABLE business_revenue ALTER COLUMN business_id      DROP NOT NULL;
ALTER TABLE business_revenue ALTER COLUMN kind             DROP NOT NULL;
ALTER TABLE business_revenue ALTER COLUMN amount_usd_cents DROP NOT NULL;
ALTER TABLE business_revenue ALTER COLUMN earnings_month   DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS biz_rev_ws_extid_idx
  ON business_revenue (workspace_id, external_sale_id)
  WHERE external_sale_id IS NOT NULL;
ALTER TABLE design_upload_queue ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE design_upload_queue ADD COLUMN IF NOT EXISTS failed_at   BIGINT;
