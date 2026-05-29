-- 0048_briefing_items_idx.sql
--
-- Composite index for the common briefing-item fetch pattern:
--   WHERE workspace_id = ? AND section = ? ORDER BY priority DESC
--
-- Without this, Postgres scans the per-workspace index, applies section
-- filter, then sorts — measurable cost when a workspace has 500+ items
-- across many briefings. The composite covers all three columns.
--
-- Idempotent; safe to re-apply.

CREATE INDEX IF NOT EXISTS bi_workspace_section_idx
  ON briefing_items (workspace_id, section);
