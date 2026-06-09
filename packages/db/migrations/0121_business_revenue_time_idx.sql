-- R553 — index for time-range queries that filter by workspace + recorded_at.
-- Used by:
--   R513 WoW/MoM comparison (SUM/COUNT over 7d/14d/30d/60d windows)
--   R511 per-platform earnings (sinceMs filter)
--   R522 refund tier re-evaluation (SUM over 30d window)
--   R367 Gumroad sales sync (sums for tier classification)
-- Without it, each query does a workspace scan + recorded_at filter — fine
-- at 10K rows but escalates at scale.
CREATE INDEX IF NOT EXISTS biz_rev_ws_time_idx
  ON business_revenue (workspace_id, recorded_at DESC);

-- R553 — partial index for refund rows so analytics can quickly filter them
-- out without scanning all metadata. metadata->>'refunded_at' is set by both
-- R367 polling and R522/R526 webhook handlers.
CREATE INDEX IF NOT EXISTS biz_rev_refunded_idx
  ON business_revenue (workspace_id, recorded_at DESC)
  WHERE (metadata->>'refunded_at') IS NOT NULL;
