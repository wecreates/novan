-- R146.155 — SB3 S-tier: questions backlog + predictive context

CREATE TABLE IF NOT EXISTS questions_backlog (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  question        TEXT NOT NULL,
  context_chunk_id TEXT,
  status          TEXT NOT NULL DEFAULT 'open',     -- 'open' | 'answered' | 'dropped'
  answer_chunk_id TEXT,
  raised_at       BIGINT NOT NULL,
  answered_at     BIGINT,
  priority        INTEGER NOT NULL DEFAULT 0       -- 0 low, 1 med, 2 high
);
CREATE INDEX IF NOT EXISTS qb_ws_status_idx ON questions_backlog(workspace_id, status, raised_at);
