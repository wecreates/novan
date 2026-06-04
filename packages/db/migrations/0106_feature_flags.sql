-- R146.191 — Unified feature flag table replacing scattered env-var kill switches.

CREATE TABLE IF NOT EXISTS feature_flag (
  key           text PRIMARY KEY,
  enabled       boolean NOT NULL DEFAULT true,
  description   text,
  updated_at    bigint NOT NULL,
  updated_by    text
);

-- Seed the known disable-by-default flags so they appear in the UI.
INSERT INTO feature_flag(key, enabled, description, updated_at) VALUES
  ('proactive_scan',        true,  'R183 proactive interruption sweep',                extract(epoch from now())*1000),
  ('radar',                 true,  'R183 threat radar snapshots',                       extract(epoch from now())*1000),
  ('money_optimize',        true,  'R180 money maximizer daily optimize',               extract(epoch from now())*1000),
  ('pentest_weekly',        true,  'R181 weekly self-pentest',                          extract(epoch from now())*1000),
  ('loop_closure',          true,  'R168 lessons→prompts + funnel→PAI outcome',         extract(epoch from now())*1000),
  ('social_comment_harvest',true,  'R161 social comment harvest',                       extract(epoch from now())*1000),
  ('audience_maint',        true,  'R162 segment refresh + win-back drafting',          extract(epoch from now())*1000),
  ('cart_recovery',         true,  'R164 cart abandonment recovery drafts',             extract(epoch from now())*1000),
  ('approved_reply_send',   true,  'R161 send approved reply drafts on cron',           extract(epoch from now())*1000),
  ('pkm_maintenance',       true,  'R150 daily snapshot + weekly review',               extract(epoch from now())*1000),
  ('auto_index',            true,  'R139 auto-extract wiki-links + tags on new chunks', extract(epoch from now())*1000),
  ('self_dev_inspect_enabled', false, 'R193 Novan self-dev: auto inspect+propose cycle (default OFF for safety)', extract(epoch from now())*1000),
  ('self_dev_apply_enabled',   false, 'R193 Novan self-dev: auto apply low-risk + high-confidence proposals (NEVER on without operator review)', extract(epoch from now())*1000)
ON CONFLICT (key) DO NOTHING;
