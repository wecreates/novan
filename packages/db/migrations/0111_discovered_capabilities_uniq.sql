-- R146.204 — discovered_capabilities had ~87K writes per 24h on 1197
-- rows (73× churn ratio). capability-auto-register.ts did SELECT-then-
-- (UPDATE-or-INSERT) on every cron tick, blindly bumping lastSeenAt
-- and re-writing exportsCount/maturity even when unchanged.
--
-- Adding a unique index on (workspace_id, service_file) — the natural
-- identity — so the caller can switch to a single atomic upsert with
-- conditional WHERE (DISTINCT) to skip no-op writes.

CREATE UNIQUE INDEX IF NOT EXISTS discovered_capabilities_ws_file_uniq
  ON discovered_capabilities (workspace_id, service_file);
