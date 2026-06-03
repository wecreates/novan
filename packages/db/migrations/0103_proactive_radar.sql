-- R146.183 — Proactive interruption + live threat radar.

CREATE TABLE IF NOT EXISTS proactive_signal (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  kind          text NOT NULL,             -- urgent_dm | whale_active | crash | funnel_drop |
                                            -- comment_high_pri | opportunity_30dph | pentest_critical
  severity      text NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  summary       text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  fired_at      bigint,
  acked_at      bigint,
  dismissed_at  bigint,
  created_at    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ps_ws_unfired_idx ON proactive_signal(workspace_id, fired_at, severity);
CREATE INDEX IF NOT EXISTS ps_ws_created_idx ON proactive_signal(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS threat_radar_snapshot (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  scan_at         bigint NOT NULL,
  open_total      integer NOT NULL DEFAULT 0,
  critical_count  integer NOT NULL DEFAULT 0,
  high_count      integer NOT NULL DEFAULT 0,
  by_source       jsonb NOT NULL DEFAULT '{}',
  by_category     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS trs_ws_idx ON threat_radar_snapshot(workspace_id, scan_at DESC);
