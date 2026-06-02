-- R146.119 — improvement_suggestions table used by r117 improvementsToOpsBridge.
-- r117 already handles the table-missing case gracefully; this just makes the
-- bridge actually fire instead of silently skipping.

CREATE TABLE IF NOT EXISTS improvement_suggestions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  category        TEXT NOT NULL DEFAULT 'misc',
  priority        TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high | critical
  status          TEXT NOT NULL DEFAULT 'open',    -- open | in_progress | done | dismissed
  mitigation_task_id TEXT,                          -- set when r117 bridges onto ops_board
  source          TEXT NOT NULL DEFAULT 'autonomous',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS imp_sug_ws_idx ON improvement_suggestions(workspace_id);
CREATE INDEX IF NOT EXISTS imp_sug_status_idx ON improvement_suggestions(workspace_id, status, priority);
CREATE INDEX IF NOT EXISTS imp_sug_bridge_idx ON improvement_suggestions(workspace_id, status, mitigation_task_id);
