-- R146.262 — Persisted brain.health snapshots for trend graphs.
-- One row per workspace per tick; bounded retention via R211 events
-- prune pattern (kept slim — full snapshot in jsonb, 1 row / 15min ≈ 96/day).

CREATE TABLE IF NOT EXISTS brain_health_snapshots (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  overall       text NOT NULL,              -- 'healthy' | 'degraded' | 'critical'
  cost_spent    double precision NOT NULL DEFAULT 0,
  cost_cap      double precision NOT NULL DEFAULT 0,
  backup_status text NOT NULL DEFAULT 'unknown',
  applier_status text NOT NULL DEFAULT 'unknown',
  cron_missing  integer NOT NULL DEFAULT 0,
  errors_1h     integer NOT NULL DEFAULT 0,
  skills_total  integer NOT NULL DEFAULT 0,
  snapshot      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS bhs_ws_created_idx ON brain_health_snapshots (workspace_id, created_at DESC);
