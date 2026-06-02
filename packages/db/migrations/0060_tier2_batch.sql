-- R146.130 — Tier 2 batch: decision memory + A/B trials

CREATE TABLE IF NOT EXISTS operator_decisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  subject_type    TEXT NOT NULL,        -- 'proposal' | 'improvement' | 'finding' | 'business' | 'channel' | 'content'
  subject_id      TEXT NOT NULL,
  decision        TEXT NOT NULL,        -- 'approved' | 'rejected' | 'dismissed' | 'snoozed' | 'edited'
  reason          TEXT,                 -- free-form
  features        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {category, risk, tags, ...} for similarity match
  decided_by      TEXT NOT NULL DEFAULT 'operator',
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS od_ws_subj_idx  ON operator_decisions(workspace_id, subject_type, created_at DESC);
CREATE INDEX IF NOT EXISTS od_subj_idx     ON operator_decisions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS od_features_gin ON operator_decisions USING GIN (features);

CREATE TABLE IF NOT EXISTS prompt_ab_trials (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  prompt_key      TEXT NOT NULL,        -- which prompt-evolution key is under test
  variant_a       TEXT NOT NULL,        -- the prompt text being challenged (champion)
  variant_b       TEXT NOT NULL,        -- the challenger
  samples_target  INTEGER NOT NULL DEFAULT 20,
  samples_done    INTEGER NOT NULL DEFAULT 0,
  wins_a          INTEGER NOT NULL DEFAULT 0,
  wins_b          INTEGER NOT NULL DEFAULT 0,
  ties            INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'running',  -- running | completed | aborted
  winner          TEXT,                 -- 'a' | 'b' | 'tie' (only when status=completed)
  started_at      BIGINT NOT NULL,
  completed_at    BIGINT
);
CREATE INDEX IF NOT EXISTS pab_ws_idx     ON prompt_ab_trials(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS pab_status_idx ON prompt_ab_trials(workspace_id, status);
