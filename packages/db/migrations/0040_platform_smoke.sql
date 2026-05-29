-- 0040_platform_smoke.sql
-- Persistent record of the brain's recurring platform self-check.
--
-- Each row = one sweep, each `probes` jsonb entry = one HTTP probe.
-- The brain (via learning-cron) runs the sweep on an interval and
-- emits `platform.smoke.regression` events when newly-failing probes
-- appear relative to the previous run.

CREATE TABLE IF NOT EXISTS "platform_smoke_runs" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "ran_at"         bigint NOT NULL,
  "duration_ms"    integer NOT NULL,
  "ok_count"       integer NOT NULL DEFAULT 0,
  "fail_count"     integer NOT NULL DEFAULT 0,
  "slow_count"     integer NOT NULL DEFAULT 0,
  "probes"         jsonb  NOT NULL DEFAULT '[]'::jsonb,
  "regressions"    jsonb  NOT NULL DEFAULT '[]'::jsonb,
  "source"         text   NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS "smoke_ws_idx"     ON "platform_smoke_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "smoke_ran_idx"    ON "platform_smoke_runs" ("ran_at");
