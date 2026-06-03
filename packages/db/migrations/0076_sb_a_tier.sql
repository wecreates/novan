-- R146.148 — Second-brain A-tier: SRS + CRM + reading queue + weekly review

CREATE TABLE IF NOT EXISTS srs_cards (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  chunk_id        TEXT NOT NULL,
  front           TEXT NOT NULL,
  back            TEXT NOT NULL,
  interval_days   INTEGER NOT NULL DEFAULT 1,
  ease            REAL NOT NULL DEFAULT 2.5,
  reps            INTEGER NOT NULL DEFAULT 0,
  next_review_at  BIGINT NOT NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS srs_due_idx ON srs_cards(workspace_id, next_review_at);

CREATE TABLE IF NOT EXISTS people (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT,
  org             TEXT,
  notes           TEXT,
  last_contact_at BIGINT,
  follow_up_at    BIGINT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS people_ws_idx     ON people(workspace_id, name);
CREATE INDEX IF NOT EXISTS people_follow_idx ON people(workspace_id, follow_up_at);

CREATE TABLE IF NOT EXISTS person_interactions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  person_id       TEXT NOT NULL,
  channel         TEXT NOT NULL,             -- 'meeting' | 'email' | 'dm' | 'call' | 'in_person'
  notes           TEXT NOT NULL,
  occurred_at     BIGINT NOT NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_person_idx ON person_interactions(person_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS reading_queue (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT,
  estimated_min   INTEGER,
  status          TEXT NOT NULL DEFAULT 'queued',  -- queued | reading | done | skipped
  notes_chunk_id  TEXT,                              -- created if operator takes notes
  added_at        BIGINT NOT NULL,
  started_at      BIGINT,
  finished_at     BIGINT
);
CREATE INDEX IF NOT EXISTS rq_ws_status_idx ON reading_queue(workspace_id, status, added_at);

CREATE TABLE IF NOT EXISTS weekly_reviews (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  week_starting   TEXT NOT NULL,             -- 'YYYY-MM-DD' (Monday)
  synthesis       TEXT NOT NULL,
  chunk_id        TEXT,                       -- linked memory chunk
  metrics         JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at    BIGINT NOT NULL,
  UNIQUE (workspace_id, week_starting)
);
