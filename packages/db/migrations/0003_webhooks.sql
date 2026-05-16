CREATE TABLE IF NOT EXISTS "webhooks" (
  "id"             text PRIMARY KEY NOT NULL,
  "workspace_id"   text NOT NULL,
  "name"           text NOT NULL,
  "secret"         text NOT NULL,
  "events"         text[] NOT NULL DEFAULT '{}',
  "target_url"     text,
  "workflow_id"    text,
  "active"         boolean NOT NULL DEFAULT true,
  "call_count"     integer NOT NULL DEFAULT 0,
  "last_called_at" bigint,
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "webhook_workspace_idx" ON "webhooks" ("workspace_id");
CREATE INDEX IF NOT EXISTS "webhook_active_idx"    ON "webhooks" ("active");
