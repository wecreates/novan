-- R146.193 — Novan Self-Dev Engine: inspect → diagnose → propose → apply.

CREATE TABLE IF NOT EXISTS self_dev_session (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  goal          text NOT NULL,
  status        text NOT NULL DEFAULT 'running',  -- running | done | failed | cancelled
  findings_count integer NOT NULL DEFAULT 0,
  proposals_count integer NOT NULL DEFAULT 0,
  applied_count integer NOT NULL DEFAULT 0,
  started_at    bigint NOT NULL,
  ended_at      bigint,
  error         text
);
CREATE INDEX IF NOT EXISTS sds_ws_idx ON self_dev_session(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS self_dev_finding (
  id            text PRIMARY KEY,
  session_id    text NOT NULL,
  workspace_id  text NOT NULL,
  dimension     text NOT NULL,                    -- smoke|errors|crons|tables|providers|...
  severity      text NOT NULL,                    -- critical|high|medium|low|info
  title         text NOT NULL,
  evidence      jsonb NOT NULL DEFAULT '{}',
  suggested_fix text,
  status        text NOT NULL DEFAULT 'open',     -- open|proposed|fixed|wontfix
  found_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sdf_session_idx ON self_dev_finding(session_id);
CREATE INDEX IF NOT EXISTS sdf_ws_status_idx ON self_dev_finding(workspace_id, status, severity);

CREATE TABLE IF NOT EXISTS self_dev_proposal (
  id            text PRIMARY KEY,
  finding_id    text NOT NULL,
  workspace_id  text NOT NULL,
  title         text NOT NULL,
  rationale     text NOT NULL,
  files         jsonb NOT NULL DEFAULT '[]',       -- [{ path, action: 'edit'|'add', diff }]
  risk_level    text NOT NULL DEFAULT 'medium',    -- low|medium|high|critical
  confidence    real NOT NULL DEFAULT 0.5,
  status        text NOT NULL DEFAULT 'draft',     -- draft|approved|applied|rejected|failed
  approval_token text,
  approved_by   text,
  approved_at   bigint,
  applied_at    bigint,
  apply_result  jsonb,
  rolled_back_at bigint,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sdp_finding_idx ON self_dev_proposal(finding_id);
CREATE INDEX IF NOT EXISTS sdp_ws_status_idx ON self_dev_proposal(workspace_id, status, created_at DESC);
