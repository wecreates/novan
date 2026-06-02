-- R146.138 — C-tier 16-20

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id    TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,             -- 'owner' | 'admin' | 'dev' | 'security' | 'va' | 'accountant' | 'observer'
  scope           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of op prefixes user is permitted
  invited_by      TEXT,
  joined_at       BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS wm_user_idx ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS negotiations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  counterparty    TEXT NOT NULL,
  topic           TEXT NOT NULL,             -- 'stripe_fees' | 'ig_ad_rate' | 'contractor_sow' | 'sponsor_rate'
  position_open   JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_walk   JSONB NOT NULL DEFAULT '{}'::jsonb,
  batna           TEXT,
  transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'drafted',  -- drafted | active | won | lost | aborted
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS neg_ws_idx ON negotiations(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS a2a_contracts (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  peer_workspace  TEXT NOT NULL,
  capability      TEXT NOT NULL,             -- what the peer provides
  revenue_split   REAL NOT NULL DEFAULT 0.5, -- 0..1 portion to peer
  status          TEXT NOT NULL DEFAULT 'proposed', -- proposed | active | closed
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS a2a_ws_idx ON a2a_contracts(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS calendar_signals (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  signal_date     TEXT NOT NULL,             -- 'YYYY-MM-DD' UTC
  energy_level    TEXT NOT NULL,             -- 'high' | 'medium' | 'low'
  predicted_load  INTEGER NOT NULL DEFAULT 0, -- back-to-back meeting count
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  recorded_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS cs_ws_date_idx ON calendar_signals(workspace_id, signal_date);

CREATE TABLE IF NOT EXISTS commitments (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  statement       TEXT NOT NULL,
  deadline_at     BIGINT NOT NULL,
  forfeit_usd     REAL NOT NULL DEFAULT 0,
  forfeit_to      TEXT,                       -- 'charity:X' or 'opponent_pubkey:Y'
  signature       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- active | fulfilled | forfeited
  resolved_at     BIGINT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_ws_idx     ON commitments(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cm_due_idx    ON commitments(workspace_id, status, deadline_at);
