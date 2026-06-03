-- R146.160 — PAI (Personal AI Infrastructure) 7-phase loop for video gen.
-- ISA = Ideal State Artifact (the brief + ISCs).
-- Each run records the seven phases + verification + outcome for LEARN.
-- Lessons are meta-patterns extracted across runs that feed forward.

CREATE TABLE IF NOT EXISTS video_isa (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  title         text NOT NULL,
  brief         text NOT NULL,                -- raw operator/agent intent
  telos         jsonb NOT NULL DEFAULT '{}',  -- mission/audience/voice snapshot
  iscs          jsonb NOT NULL DEFAULT '[]',  -- array of { id, criterion, weight, kind }
  target        jsonb NOT NULL DEFAULT '{}',  -- { platform, durationSec, aspect, ctaType }
  status        text NOT NULL DEFAULT 'active',
  created_at    bigint NOT NULL,
  archived_at   bigint
);
CREATE INDEX IF NOT EXISTS vi_ws_idx ON video_isa(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS video_pai_run (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  isa_id        text NOT NULL,
  episode_id    text,                          -- ai-video-studio Episode id once PLAN runs
  phase         text NOT NULL DEFAULT 'observe', -- observe|think|plan|build|execute|verify|learn|done|failed
  observe       jsonb NOT NULL DEFAULT '{}',
  think         jsonb NOT NULL DEFAULT '{}',
  plan          jsonb NOT NULL DEFAULT '{}',
  build         jsonb NOT NULL DEFAULT '{}',
  execute       jsonb NOT NULL DEFAULT '{}',
  verify        jsonb NOT NULL DEFAULT '{}',
  learn         jsonb NOT NULL DEFAULT '{}',
  isc_pass_rate real NOT NULL DEFAULT 0,       -- 0..1 from VERIFY
  outcome_score real,                          -- set later by recordOutcome (engagement/revenue normalized)
  outcome_meta  jsonb NOT NULL DEFAULT '{}',   -- { views, likes, ctr, revenueCents }
  cost_usd      real NOT NULL DEFAULT 0,
  started_at    bigint NOT NULL,
  ended_at      bigint,
  error         text
);
CREATE INDEX IF NOT EXISTS vpr_ws_idx ON video_pai_run(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS vpr_isa_idx ON video_pai_run(isa_id, started_at DESC);
CREATE INDEX IF NOT EXISTS vpr_outcome_idx ON video_pai_run(workspace_id, outcome_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS video_pai_lesson (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  topic         text NOT NULL,            -- 'hook' | 'duration' | 'voice' | 'shot-pacing' | 'cta' | 'thumbnail'
  pattern       text NOT NULL,            -- short rule e.g. "hooks under 2.5s outperform"
  evidence      jsonb NOT NULL DEFAULT '{}', -- runIds + scores it was derived from
  confidence    real NOT NULL DEFAULT 0.5,
  uses          integer NOT NULL DEFAULT 0,
  wins          integer NOT NULL DEFAULT 0,
  losses        integer NOT NULL DEFAULT 0,
  created_at    bigint NOT NULL,
  retired_at    bigint
);
CREATE INDEX IF NOT EXISTS vpl_ws_idx ON video_pai_lesson(workspace_id, topic, confidence DESC);
