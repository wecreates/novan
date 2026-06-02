-- 0054 — Second Brain (R146.114)
-- cryptocita-style /raw → /wiki pipeline with CLAUDE.md rules + 3 crons.

CREATE TABLE IF NOT EXISTS "second_brain_raw" (
  "id"            text PRIMARY KEY NOT NULL,
  "workspace_id"  text NOT NULL,
  "source"        text NOT NULL,
  "url"           text,
  "title"         text,
  "content"       text,
  "tags_hint"     text,
  "status"        text NOT NULL DEFAULT 'queued',
  "compiled_at"   bigint,
  "compile_error" text,
  "article_ids"   jsonb,
  "dropped_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sb_raw_ws_status_idx" ON "second_brain_raw" ("workspace_id", "status", "dropped_at");

CREATE TABLE IF NOT EXISTS "second_brain_articles" (
  "id"            text PRIMARY KEY NOT NULL,
  "workspace_id"  text NOT NULL,
  "topic"         text NOT NULL,
  "slug"          text NOT NULL,
  "title"         text NOT NULL,
  "body"          text NOT NULL,
  "key_takeaways" jsonb,
  "links"         jsonb,
  "source_raw_ids" jsonb,
  "embedding"     vector(1536),
  "created_at"    bigint NOT NULL,
  "updated_at"    bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sb_articles_ws_topic_slug_idx" ON "second_brain_articles" ("workspace_id", "topic", "slug");
CREATE INDEX IF NOT EXISTS "sb_articles_ws_topic_idx" ON "second_brain_articles" ("workspace_id", "topic", "updated_at");

CREATE TABLE IF NOT EXISTS "second_brain_config" (
  "workspace_id"        text PRIMARY KEY NOT NULL,
  "rules_md"            text NOT NULL DEFAULT '',
  "daily_ingest_hour"   integer NOT NULL DEFAULT 7,
  "daily_review_hour"   integer NOT NULL DEFAULT 18,
  "weekly_audit_day"    integer NOT NULL DEFAULT 0,
  "weekly_audit_hour"   integer NOT NULL DEFAULT 9,
  "enabled"             boolean NOT NULL DEFAULT true,
  "updated_at"          bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS "second_brain_reviews" (
  "id"                  text PRIMARY KEY NOT NULL,
  "workspace_id"        text NOT NULL,
  "kind"                text NOT NULL,
  "summary"             text,
  "changed_article_ids" jsonb,
  "gaps"                jsonb,
  "broken_links"        jsonb,
  "run_at"              bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sb_reviews_ws_kind_idx" ON "second_brain_reviews" ("workspace_id", "kind", "run_at");
