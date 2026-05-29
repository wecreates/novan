-- 0037_conversation_branching.sql
-- Conversation branching: forking a conversation creates a new conversation
-- that shares history up to a specific message id, then diverges.
--
-- forked_from_conversation_id — points at the parent conversation
-- forked_from_message_id      — the message id we forked AFTER (history
--                               is copied through and including this id)
-- branch_root_id              — the original root of the branch tree, so
--                               we can show the whole forest from any node.
--                               NULL on the root conversation itself.

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "forked_from_conversation_id" text,
  ADD COLUMN IF NOT EXISTS "forked_from_message_id"      text,
  ADD COLUMN IF NOT EXISTS "branch_root_id"              text;

CREATE INDEX IF NOT EXISTS "conv_branch_root_idx"
  ON "conversations" ("branch_root_id");

CREATE INDEX IF NOT EXISTS "conv_forked_from_idx"
  ON "conversations" ("forked_from_conversation_id");
