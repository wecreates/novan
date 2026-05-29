-- 0033_image_quality.sql
-- Per-generation quality / anti-slop / originality scores.
-- Persisted as a separate table to avoid bloating image_generations and
-- to keep score re-runs cheap.

ALTER TABLE "image_generations"
  ADD COLUMN IF NOT EXISTS "slop_risk_score"         real,
  ADD COLUMN IF NOT EXISTS "originality_score"       real,
  ADD COLUMN IF NOT EXISTS "composition_score"       real,
  ADD COLUMN IF NOT EXISTS "brand_fit_score"         real,
  ADD COLUMN IF NOT EXISTS "creative_flags"          jsonb;

CREATE TABLE IF NOT EXISTS "image_quality_reviews" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "generation_id"  text NOT NULL,
  "kind"           text NOT NULL,         -- auto | operator | agent
  "verdict"        text NOT NULL,         -- approve | flag | reject
  "composite"      real NOT NULL,
  "quality_score"  real NOT NULL,
  "slop_risk"      real NOT NULL,
  "originality"    real NOT NULL,
  "composition"    real NOT NULL,
  "brand_fit"      real NOT NULL,
  "reasons"        jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reviewer"       text,
  "created_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "iqr_workspace_idx"  ON "image_quality_reviews" ("workspace_id");
CREATE INDEX IF NOT EXISTS "iqr_generation_idx" ON "image_quality_reviews" ("generation_id");
CREATE INDEX IF NOT EXISTS "iqr_verdict_idx"    ON "image_quality_reviews" ("verdict");
CREATE INDEX IF NOT EXISTS "iqr_created_idx"    ON "image_quality_reviews" ("created_at");
