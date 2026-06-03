-- R146.178 — Managed accounts + warm-up plans + maximum-volume cadence.

CREATE TABLE IF NOT EXISTS managed_account (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  business_id         text,
  platform            text NOT NULL,
  handle              text NOT NULL,
  display_name        text,
  role                text NOT NULL DEFAULT 'primary',   -- primary | secondary
  vault_user_secret_id text NOT NULL,
  vault_pass_secret_id text NOT NULL,
  vault_totp_secret_id text,                              -- TOTP seed if 2FA
  requires_2fa        boolean NOT NULL DEFAULT false,
  status              text NOT NULL DEFAULT 'creating',   -- creating | warming | active | paused | banned
  warmup_day_index    integer NOT NULL DEFAULT 0,
  warmup_started_at   bigint,
  warmup_completed_at bigint,
  last_signin_at      bigint,
  last_health_at      bigint,
  health              text NOT NULL DEFAULT 'unknown',    -- healthy | degraded | shadowbanned | banned | unknown
  signals             jsonb NOT NULL DEFAULT '{}',
  created_at          bigint NOT NULL,
  updated_at          bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ma_ws_platform_handle_idx ON managed_account(workspace_id, platform, handle);
CREATE INDEX IF NOT EXISTS ma_ws_status_idx ON managed_account(workspace_id, status);

CREATE TABLE IF NOT EXISTS warmup_plan (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  account_id    text NOT NULL,
  platform      text NOT NULL,
  day_count     integer NOT NULL,
  curve         jsonb NOT NULL DEFAULT '[]',              -- [{day, targets: [{kind, count}]}]
  started_at    bigint NOT NULL,
  completed_at  bigint,
  status        text NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS wp_ws_idx ON warmup_plan(workspace_id);
CREATE INDEX IF NOT EXISTS wp_account_idx ON warmup_plan(account_id);

CREATE TABLE IF NOT EXISTS warmup_day (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  plan_id       text NOT NULL,
  day_index     integer NOT NULL,
  targets       jsonb NOT NULL DEFAULT '[]',              -- [{kind, count}]
  completed     jsonb NOT NULL DEFAULT '{}',              -- { kind: count }
  status        text NOT NULL DEFAULT 'pending',          -- pending | running | done | skipped | failed
  executed_at   bigint,
  error         text
);
CREATE UNIQUE INDEX IF NOT EXISTS wd_plan_day_idx ON warmup_day(plan_id, day_index);
