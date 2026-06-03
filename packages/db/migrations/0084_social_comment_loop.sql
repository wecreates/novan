-- R146.161 — Social comment harvesting + self-improvement loop.
-- Unifies comments across YouTube / Instagram / TikTok behind one shape,
-- classifies sentiment+intent, rolls up themes, mints lessons that feed
-- back into prompt-evolution and the PAI video loop.

CREATE TABLE IF NOT EXISTS social_comment (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  platform        text NOT NULL,           -- youtube | instagram | tiktok | x
  account_id      text NOT NULL,           -- connectorAccounts.id
  post_id         text,                    -- socialPosts.id when known
  external_post_id text,                   -- platform's video/media id
  external_id     text NOT NULL,           -- platform's comment id (unique within platform)
  author_handle   text,
  author_id       text,
  body            text NOT NULL,
  published_at    bigint,
  fetched_at      bigint NOT NULL,
  sentiment       text,                    -- pos | neg | neutral | mixed
  intent          text,                    -- question | request | praise | complaint | spam | other
  themes          jsonb NOT NULL DEFAULT '[]',  -- string[] keyword themes
  reply_priority  integer NOT NULL DEFAULT 0,   -- 0..100 — higher = answer first
  hidden_at       bigint,
  replied_at      bigint,
  reply_external_id text
);
CREATE UNIQUE INDEX IF NOT EXISTS sc_platform_extid_idx ON social_comment(platform, external_id);
CREATE INDEX IF NOT EXISTS sc_ws_idx ON social_comment(workspace_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS sc_ws_intent_idx ON social_comment(workspace_id, intent, fetched_at DESC);
CREATE INDEX IF NOT EXISTS sc_ws_priority_idx ON social_comment(workspace_id, replied_at, reply_priority DESC);

CREATE TABLE IF NOT EXISTS social_comment_theme (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  theme           text NOT NULL,
  count           integer NOT NULL DEFAULT 0,
  pos_count       integer NOT NULL DEFAULT 0,
  neg_count       integer NOT NULL DEFAULT 0,
  sentiment_avg   real NOT NULL DEFAULT 0,   -- -1..1
  first_seen_at   bigint NOT NULL,
  last_seen_at    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sct_ws_theme_idx ON social_comment_theme(workspace_id, theme);
CREATE INDEX IF NOT EXISTS sct_ws_count_idx ON social_comment_theme(workspace_id, count DESC);

CREATE TABLE IF NOT EXISTS social_reply_draft (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL,
  comment_id      text NOT NULL,
  body            text NOT NULL,
  source          text NOT NULL DEFAULT 'rules', -- rules | llm | operator
  model           text,
  status          text NOT NULL DEFAULT 'draft', -- draft | approved | rejected | sent | failed
  approved_by     text,
  approved_at     bigint,
  sent_at         bigint,
  send_error      text,
  created_at      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS srd_ws_idx ON social_reply_draft(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS srd_comment_idx ON social_reply_draft(comment_id);
