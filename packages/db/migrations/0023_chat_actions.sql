-- 0023_chat_actions.sql
-- Inline action suggestions surfaced in chat with approval gating.

CREATE TABLE IF NOT EXISTS "chat_actions" (
  "id"                text PRIMARY KEY,
  "message_id"        text NOT NULL,
  "conversation_id"   text NOT NULL,
  "workspace_id"      text NOT NULL,
  "action_type"       text NOT NULL,    -- dispatcher action_type
  "title"             text NOT NULL,
  "summary"           text NOT NULL,
  "payload"           jsonb NOT NULL DEFAULT '{}',
  "risk_level"        text NOT NULL DEFAULT 'low',   -- low | medium | high | critical
  "status"            text NOT NULL DEFAULT 'suggested', -- suggested | approved | rejected | executed | failed
  "executed_action_id" text,                -- references actions.id once dispatched
  "executed_result"   jsonb,
  "decided_by"        text,
  "decided_at"        bigint,
  "reason"            text,
  "created_at"        bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ca2_message_idx"   ON "chat_actions" ("message_id");
CREATE INDEX IF NOT EXISTS "ca2_workspace_idx" ON "chat_actions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ca2_status_idx"    ON "chat_actions" ("status");
