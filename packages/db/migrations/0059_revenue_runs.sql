-- R146.129 — revenue execution loop state

CREATE TABLE IF NOT EXISTS revenue_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  idea_title          TEXT NOT NULL,
  idea_pitch          TEXT NOT NULL,
  current_step        TEXT NOT NULL DEFAULT 'idea',
  status              TEXT NOT NULL DEFAULT 'running',
  business_id         TEXT,
  channel_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  scores              JSONB NOT NULL DEFAULT '{}'::jsonb,
  feasibility         JSONB NOT NULL DEFAULT '{}'::jsonb,
  halt_reason         TEXT,
  approvals_pending   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rr_ws_idx     ON revenue_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rr_status_idx ON revenue_runs(workspace_id, status, current_step);
