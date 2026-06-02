-- R146.135 — S-tier: twin sim + speculative posting + agent auctions + constitutional audit + reverse funnel

CREATE TABLE IF NOT EXISTS twin_sim_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  target_run_type TEXT NOT NULL,             -- 'revenue' | 'pod_batch' | 'business_create'
  target_input    JSONB NOT NULL DEFAULT '{}'::jsonb,
  horizon_days    INTEGER NOT NULL DEFAULT 30,
  projected       JSONB NOT NULL DEFAULT '{}'::jsonb,   -- projected metrics
  recommendation  TEXT NOT NULL DEFAULT 'review',       -- 'go' | 'review' | 'block'
  reasoning       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tsr_ws_idx ON twin_sim_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS speculative_tests (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  base_clip_id    TEXT,
  variants        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{label, hook, platform, postId, metrics}]
  burner_minutes  INTEGER NOT NULL DEFAULT 60,
  status          TEXT NOT NULL DEFAULT 'running',      -- running | scored | promoted | aborted
  winner_label    TEXT,
  promoted_to     TEXT,                                 -- main account id
  started_at      BIGINT NOT NULL,
  scored_at       BIGINT
);
CREATE INDEX IF NOT EXISTS st_ws_idx ON speculative_tests(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS task_auctions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  task_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  bids            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{agentId, costUsd, confidence, etaSec, score}]
  winner_agent_id TEXT,
  status          TEXT NOT NULL DEFAULT 'open',         -- open | awarded | executed | failed
  opened_at       BIGINT NOT NULL,
  awarded_at      BIGINT,
  executed_at     BIGINT,
  result          JSONB
);
CREATE INDEX IF NOT EXISTS ta_ws_idx     ON task_auctions(workspace_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS ta_status_idx ON task_auctions(workspace_id, status);

CREATE TABLE IF NOT EXISTS constitutional_audits (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  audit_kind      TEXT NOT NULL,                        -- 'weekly' | 'on_demand'
  mission_drift   REAL NOT NULL DEFAULT 0,              -- 0..1 score
  manipulation    REAL NOT NULL DEFAULT 0,
  scope_creep     REAL NOT NULL DEFAULT 0,
  findings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  remediation     JSONB NOT NULL DEFAULT '[]'::jsonb,
  audited_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ca_ws_idx ON constitutional_audits(workspace_id, audited_at DESC);

CREATE TABLE IF NOT EXISTS funnel_simulations (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  target_usd_mo   REAL NOT NULL,
  horizon_months  INTEGER NOT NULL,
  paths           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{label, probability, monthlyTrajectory, gates}]
  recommended     TEXT,                                  -- label of top path
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS fs_ws_idx ON funnel_simulations(workspace_id, created_at DESC);
