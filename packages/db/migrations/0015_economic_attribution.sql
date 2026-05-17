-- 0015_economic_attribution.sql
-- Adds nullable trace/workflow attribution columns to cost-bearing tables
-- so per-workflow / per-trace cost attribution can be FACT rather than
-- estimate when callers populate them. All columns are nullable; existing
-- rows and untouched callers stay valid.

ALTER TABLE "ai_usage"
  ADD COLUMN IF NOT EXISTS "trace_id"         text,
  ADD COLUMN IF NOT EXISTS "workflow_run_id"  text;

CREATE INDEX IF NOT EXISTS "ai_usage_trace_idx"    ON "ai_usage" ("trace_id");
CREATE INDEX IF NOT EXISTS "ai_usage_workflow_idx" ON "ai_usage" ("workflow_run_id");

ALTER TABLE "image_generations"
  ADD COLUMN IF NOT EXISTS "trace_id"         text,
  ADD COLUMN IF NOT EXISTS "workflow_run_id"  text;

CREATE INDEX IF NOT EXISTS "ig_trace_idx"    ON "image_generations" ("trace_id");
CREATE INDEX IF NOT EXISTS "ig_workflow_idx" ON "image_generations" ("workflow_run_id");

-- execution_leases already has metadata jsonb + jobId; we add an explicit
-- workflow_run_id for cheap indexed joins.
ALTER TABLE "execution_leases"
  ADD COLUMN IF NOT EXISTS "workflow_run_id"  text;

CREATE INDEX IF NOT EXISTS "el_workflow_idx" ON "execution_leases" ("workflow_run_id");
