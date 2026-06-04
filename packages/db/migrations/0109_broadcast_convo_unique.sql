-- R146.200 — Partial unique index on (workspace_id) where title='Brain
-- broadcast'. brain-broadcast.ensureBroadcastConversation had the same
-- SELECT-then-INSERT TOCTOU as R199 (operator_presence). At most one
-- broadcast conversation should exist per workspace; enforce it at the
-- DB level so onConflictDoNothing() in the code can rely on it.

CREATE UNIQUE INDEX IF NOT EXISTS conversations_broadcast_ws_uniq
  ON conversations (workspace_id)
  WHERE title = 'Brain broadcast';
