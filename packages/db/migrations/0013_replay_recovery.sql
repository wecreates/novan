-- Phase 3: Replay, Recovery, and Disaster Hardening
-- replay_runs, replay_divergences

-- ─── Replay Runs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "replay_runs" (
  "id"                   text PRIMARY KEY,
  "workspace_id"         text NOT NULL,
  "source_run_id"        text NOT NULL,    -- original workflow run being replayed
  "checkpoint_id"        text,             -- null = replay from beginning
  "status"               text NOT NULL DEFAULT 'running',  -- running | completed | failed | diverged
  "event_count"          integer NOT NULL DEFAULT 0,
  "replayed_count"       integer NOT NULL DEFAULT 0,
  "diverged_at_event_id" text,
  "divergence_reason"    text,
  "started_at"           bigint NOT NULL,
  "completed_at"         bigint,
  "created_at"           bigint NOT NULL,
  "updated_at"           bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "rr_workspace_idx"   ON "replay_runs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rr_source_run_idx"  ON "replay_runs" ("source_run_id");
CREATE INDEX IF NOT EXISTS "rr_status_idx"      ON "replay_runs" ("status");
CREATE INDEX IF NOT EXISTS "rr_created_idx"     ON "replay_runs" ("created_at");

-- ─── Replay Divergences ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "replay_divergences" (
  "id"               text PRIMARY KEY,
  "workspace_id"     text NOT NULL,
  "replay_run_id"    text NOT NULL,
  "event_id"         text NOT NULL,
  "event_type"       text NOT NULL,
  "expected_state"   jsonb NOT NULL,
  "actual_state"     jsonb NOT NULL,
  "divergence_type"  text NOT NULL,  -- state_mismatch | missing_event | extra_event | unexpected_error
  "created_at"       bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "rd_workspace_idx"    ON "replay_divergences" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rd_replay_run_idx"   ON "replay_divergences" ("replay_run_id");
CREATE INDEX IF NOT EXISTS "rd_created_idx"      ON "replay_divergences" ("created_at");
