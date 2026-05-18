-- 0018_loop_credibility.sql
-- Adds shipped-vs-approved tracking to code proposals so the autonomy
-- loop credibility can be measured: how many approved → how many shipped.

ALTER TABLE "code_proposals"
  ADD COLUMN IF NOT EXISTS "shipped_at"         bigint,
  ADD COLUMN IF NOT EXISTS "shipped_commit_sha" text,
  ADD COLUMN IF NOT EXISTS "shipped_by"         text;

CREATE INDEX IF NOT EXISTS "cp_shipped_idx" ON "code_proposals" ("shipped_at");
