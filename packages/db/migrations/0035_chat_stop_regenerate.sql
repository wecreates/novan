-- 0035_chat_stop_regenerate.sql
-- Stop + Regenerate UX for the Talk page.

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "superseded_at"     bigint,
  ADD COLUMN IF NOT EXISTS "superseded_by"     text,         -- id of the message that replaced this one
  ADD COLUMN IF NOT EXISTS "regenerated_from"  text,         -- id of the message this regenerated from
  ADD COLUMN IF NOT EXISTS "cancelled"         boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "msg_superseded_idx" ON "messages" ("superseded_at");
