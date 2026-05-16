CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "id"           text PRIMARY KEY NOT NULL,
  "webhook_id"   text NOT NULL REFERENCES "webhooks"("id") ON DELETE CASCADE,
  "workspace_id" text NOT NULL,
  "event_type"   text NOT NULL,
  "payload"      jsonb NOT NULL DEFAULT '{}',
  "status"       text NOT NULL DEFAULT 'received',
  "run_id"       text,
  "error"        text,
  "created_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "wdel_webhook_idx"   ON "webhook_deliveries" ("webhook_id");
CREATE INDEX IF NOT EXISTS "wdel_workspace_idx" ON "webhook_deliveries" ("workspace_id");
