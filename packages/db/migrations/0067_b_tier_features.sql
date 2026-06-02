-- R146.137 — B-tier 11-15

CREATE TABLE IF NOT EXISTS injection_scans (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  source          TEXT NOT NULL,             -- 'transcript' | 'scraped_page' | 'oauth_payload' | 'user_input'
  source_ref      TEXT,
  verdict         TEXT NOT NULL,             -- 'clean' | 'suspicious' | 'malicious'
  matched         JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash    TEXT NOT NULL,
  scanned_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS is_ws_idx     ON injection_scans(workspace_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS is_verdict_idx ON injection_scans(workspace_id, verdict, scanned_at);

CREATE TABLE IF NOT EXISTS redteam_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  attacks         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, target, vector, result}]
  vulnerabilities INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      BIGINT NOT NULL,
  finished_at     BIGINT
);
CREATE INDEX IF NOT EXISTS rt_ws_idx ON redteam_runs(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS content_provenance (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  post_id         TEXT,
  clip_id         TEXT,
  manifest        JSONB NOT NULL,             -- {clipId, template, approvalId, model, prompt, timestamp}
  signature       TEXT NOT NULL,             -- hmac-sha256 of canonical(manifest)
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS cp_post_idx ON content_provenance(post_id);
CREATE INDEX IF NOT EXISTS cp_clip_idx ON content_provenance(clip_id);

CREATE TABLE IF NOT EXISTS skill_roi (
  workspace_id    TEXT NOT NULL,
  op_name         TEXT NOT NULL,
  calls           INTEGER NOT NULL DEFAULT 0,
  cost_usd_total  REAL NOT NULL DEFAULT 0,
  revenue_attributed_usd REAL NOT NULL DEFAULT 0,
  last_call_at    BIGINT,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, op_name)
);

CREATE TABLE IF NOT EXISTS agent_demotions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  cost_per_task   REAL,
  value_per_task  REAL,
  action          TEXT NOT NULL,             -- 'throttle' | 'retire' | 'reactivate'
  decided_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_ws_agent_idx ON agent_demotions(workspace_id, agent_id, decided_at);
