-- R146.230 — Partial unique index for drift_warnings.
-- drift-detector.ts:dedupedWarn does SELECT-then-INSERT, returning early
-- when a row matching (workspace, kind, subject_id_or_null, status IN
-- ('open','acknowledged')) already exists. The race window: two concurrent
-- detectors both observe "no row" and both INSERT, producing duplicate
-- warnings.
--
-- Add a PARTIAL unique index — uniqueness only enforced for rows in
-- ('open','acknowledged') status. Resolved/dismissed rows can repeat.
-- Two indexes are needed because PG treats NULL as distinct in unique
-- indexes; one for the subject_id IS NOT NULL case, one for IS NULL.

CREATE UNIQUE INDEX IF NOT EXISTS drift_warnings_open_with_subject_uniq
  ON drift_warnings (workspace_id, kind, subject_id)
  WHERE status IN ('open', 'acknowledged') AND subject_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS drift_warnings_open_no_subject_uniq
  ON drift_warnings (workspace_id, kind)
  WHERE status IN ('open', 'acknowledged') AND subject_id IS NULL;
