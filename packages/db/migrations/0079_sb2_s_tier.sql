-- R146.151 — SB2 S-tier: habits + OKRs + pomodoro + mood + templates

CREATE TABLE IF NOT EXISTS habits (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  cadence         TEXT NOT NULL DEFAULT 'daily',     -- daily | weekly | weekdays
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  current_streak  INTEGER NOT NULL DEFAULT 0,
  longest_streak  INTEGER NOT NULL DEFAULT 0,
  last_done_date  TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS habits_ws_idx ON habits(workspace_id, active);

CREATE TABLE IF NOT EXISTS habit_logs (
  workspace_id    TEXT NOT NULL,
  habit_id        TEXT NOT NULL,
  date            TEXT NOT NULL,
  done            BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  logged_at       BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, habit_id, date)
);

CREATE TABLE IF NOT EXISTS objectives (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  title           TEXT NOT NULL,
  quarter         TEXT NOT NULL,                      -- 'Y-Q' e.g. '2026-Q3'
  status          TEXT NOT NULL DEFAULT 'active',     -- active | done | dropped
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS obj_ws_idx ON objectives(workspace_id, quarter, status);

CREATE TABLE IF NOT EXISTS key_results (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  objective_id    TEXT NOT NULL,
  title           TEXT NOT NULL,
  target_value    REAL,
  current_value   REAL NOT NULL DEFAULT 0,
  unit            TEXT,
  confidence      REAL NOT NULL DEFAULT 0.5,
  updated_at      BIGINT NOT NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS kr_obj_idx ON key_results(objective_id);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  description     TEXT NOT NULL,
  duration_min    INTEGER NOT NULL,
  output_chunk_id TEXT,
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at      BIGINT NOT NULL,
  finished_at     BIGINT
);
CREATE INDEX IF NOT EXISTS fs_ws_idx ON focus_sessions(workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS mood_logs (
  workspace_id    TEXT NOT NULL,
  date            TEXT NOT NULL,
  slot            TEXT NOT NULL,                      -- 'morning' | 'midday' | 'evening'
  mood            INTEGER NOT NULL,                   -- 1..5
  energy          INTEGER NOT NULL,                   -- 1..5
  notes           TEXT,
  logged_at       BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, date, slot)
);

CREATE TABLE IF NOT EXISTS note_templates (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  body            TEXT NOT NULL,                      -- with {{vars}}
  variables       JSONB NOT NULL DEFAULT '[]'::jsonb, -- ['title','date','attendees']
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS nt_ws_idx ON note_templates(workspace_id, name);
