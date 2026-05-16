CREATE TABLE IF NOT EXISTS "notifications" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "title"        text NOT NULL,
  "body"         text NOT NULL,
  "type"         text NOT NULL DEFAULT 'info',
  "category"     text NOT NULL DEFAULT 'system',
  "read"         boolean NOT NULL DEFAULT false,
  "dismissed"    boolean NOT NULL DEFAULT false,
  "source_type"  text,
  "source_id"    text,
  "action_url"   text,
  "expires_at"   bigint,
  "created_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "notif_workspace_idx" ON "notifications" ("workspace_id");
CREATE INDEX IF NOT EXISTS "notif_read_idx"      ON "notifications" ("read");
CREATE INDEX IF NOT EXISTS "notif_created_idx"   ON "notifications" ("created_at");
