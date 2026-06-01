-- R146.86 — experiments + hypotheses tables.
-- Foundation for the brain's learning loop: every change to a business or
-- platform strategy gets logged as an experiment with a falsifiable
-- prediction; we measure the outcome and feed the result back into prompt
-- evolution + reasoning chains.

CREATE TABLE IF NOT EXISTS experiments (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id   text REFERENCES businesses(id) ON DELETE SET NULL,
  title         text NOT NULL,
  hypothesis    text NOT NULL,
  prediction    text NOT NULL,           -- falsifiable outcome statement
  metric        text NOT NULL,           -- which metric we'll measure
  baseline      jsonb,                   -- pre-experiment state
  intervention  text NOT NULL,           -- what we changed
  start_at      bigint NOT NULL,
  end_at        bigint,                  -- null = still running
  status        text NOT NULL DEFAULT 'running',  -- running | concluded | abandoned
  outcome       jsonb,                   -- post-experiment state
  verdict       text,                    -- supported | refuted | inconclusive
  lessons       text,
  confidence_pre  numeric,               -- 0..1 confidence before
  confidence_post numeric,               -- 0..1 actual rate-of-success after
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS experiments_ws_status_idx ON experiments(workspace_id, status);
CREATE INDEX IF NOT EXISTS experiments_business_idx ON experiments(business_id);

CREATE TABLE IF NOT EXISTS hypotheses (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject       text NOT NULL,           -- what the brain is reasoning about
  claim         text NOT NULL,           -- the belief
  prediction    text NOT NULL,           -- falsifiable consequence
  confidence    numeric NOT NULL,        -- 0..1 at time of authoring
  evidence_for  jsonb NOT NULL DEFAULT '[]',
  evidence_against jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'open',  -- open | supported | refuted | superseded
  reviewed_at   bigint,
  related_chain text,                    -- reasoning_chains.id link
  created_at    bigint NOT NULL,
  updated_at    bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS hypotheses_ws_status_idx ON hypotheses(workspace_id, status);
CREATE INDEX IF NOT EXISTS hypotheses_subject_idx ON hypotheses(workspace_id, subject);

-- Calibration log: every time the brain emits a confidence estimate and
-- then we later observe the outcome, log it. Aggregations let us produce
-- the brutal "the brain said 70% confident → it actually happened 50%" plot.
CREATE TABLE IF NOT EXISTS calibration_observations (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_type  text NOT NULL,           -- hypothesis | experiment | plan_step
  subject_id    text NOT NULL,
  claimed_confidence numeric NOT NULL,   -- 0..1
  outcome       text NOT NULL,           -- true | false | partial
  outcome_score numeric,                 -- 0..1 partial-credit
  observed_at   bigint NOT NULL,
  notes         text
);

CREATE INDEX IF NOT EXISTS calibration_ws_subject_idx ON calibration_observations(workspace_id, subject_type, observed_at);
