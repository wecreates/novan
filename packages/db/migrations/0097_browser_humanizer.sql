-- R146.177 — Browser session humanizer + spend-lock + action audit.
-- Built on top of brain-task-browser (Playwright). Every action goes
-- through humanizeAction() → screened against spend-lock + ToS-warn
-- patterns + executed with human-paced pauses/typing → audit logged.

CREATE TABLE IF NOT EXISTS humanizer_profile (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  account_id      text,                          -- nullable = workspace default
  typing_wpm_min  integer NOT NULL DEFAULT 35,
  typing_wpm_max  integer NOT NULL DEFAULT 75,
  mouse_jitter_px integer NOT NULL DEFAULT 4,
  pause_min_ms    integer NOT NULL DEFAULT 250,
  pause_max_ms    integer NOT NULL DEFAULT 1800,
  idle_jitter_ms  integer NOT NULL DEFAULT 600,
  peak_hours      jsonb NOT NULL DEFAULT '[]',   -- [9,10,11,17,18,19,20,21] local
  daily_caps      jsonb NOT NULL DEFAULT '{}',   -- { tiktok: {posts:5,interactions:200}, ... }
  weekend_factor  real NOT NULL DEFAULT 1.15,    -- slightly more activity on weekends
  status          text NOT NULL DEFAULT 'active',
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS hp_ws_idx ON humanizer_profile(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS hp_ws_acct_idx ON humanizer_profile(workspace_id, coalesce(account_id, 'DEFAULT'));

CREATE TABLE IF NOT EXISTS browser_action_log (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  account_id      text,
  session_id      text NOT NULL,
  platform        text,
  kind            text NOT NULL,                 -- navigate | type | click | scroll | wait | screenshot | read | fill | submit | back
  target          text,
  args            jsonb NOT NULL DEFAULT '{}',
  result          jsonb NOT NULL DEFAULT '{}',
  spend_blocked   boolean NOT NULL DEFAULT false,
  tos_warning     text,                          -- non-blocking advisory
  pause_ms_used   integer,
  success         boolean NOT NULL DEFAULT false,
  error           text,
  started_at      bigint NOT NULL,
  ended_at        bigint
);
CREATE INDEX IF NOT EXISTS bal_ws_idx ON browser_action_log(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS bal_session_idx ON browser_action_log(session_id, started_at);
CREATE INDEX IF NOT EXISTS bal_account_idx ON browser_action_log(account_id, started_at);
