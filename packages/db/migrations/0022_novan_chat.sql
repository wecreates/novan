-- 0022_novan_chat.sql
-- Persistent operator-facing chat with Novan.

CREATE TABLE IF NOT EXISTS "conversations" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "title"           text NOT NULL,
  "message_count"   integer NOT NULL DEFAULT 0,
  "total_tokens"    integer NOT NULL DEFAULT 0,
  "total_cost_usd"  real NOT NULL DEFAULT 0,
  "archived"        boolean NOT NULL DEFAULT false,
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "conv_workspace_idx" ON "conversations" ("workspace_id");
CREATE INDEX IF NOT EXISTS "conv_updated_idx"   ON "conversations" ("updated_at");

CREATE TABLE IF NOT EXISTS "messages" (
  "id"              text PRIMARY KEY,
  "conversation_id" text NOT NULL,
  "workspace_id"    text NOT NULL,
  "role"            text NOT NULL,   -- user | assistant | system
  "content"         text NOT NULL,
  "citations"       jsonb NOT NULL DEFAULT '[]',
  "audit"           jsonb,
  "tokens"          integer NOT NULL DEFAULT 0,
  "cost_usd"        real NOT NULL DEFAULT 0,
  "provider"        text,
  "model"           text,
  "stream_complete" boolean NOT NULL DEFAULT true,
  "error"           text,
  "created_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "msg_conv_idx"      ON "messages" ("conversation_id");
CREATE INDEX IF NOT EXISTS "msg_workspace_idx" ON "messages" ("workspace_id");
CREATE INDEX IF NOT EXISTS "msg_created_idx"   ON "messages" ("created_at");
