-- Learning Runtime tables
-- All tables are workspace-scoped. Evidence required for every signal/pattern/insight.

CREATE TABLE IF NOT EXISTS "learning_signals" (
  "id"                  text PRIMARY KEY NOT NULL,
  "workspace_id"        text NOT NULL,
  "source"              text NOT NULL,
  "source_event_id"     text,
  "source_workflow_id"  text,
  "source_run_id"       text,
  "source_memory_id"    text,
  "signal"              text NOT NULL,
  "evidence"            jsonb NOT NULL DEFAULT '{}',
  "confidence"          real NOT NULL DEFAULT 1.0,
  "status"              text NOT NULL DEFAULT 'new',
  "review_required"     boolean NOT NULL DEFAULT false,
  "pattern_id"          text,
  "created_at"          bigint NOT NULL,
  "updated_at"          bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "ls_workspace_idx" ON "learning_signals" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ls_source_idx"    ON "learning_signals" ("source");
CREATE INDEX IF NOT EXISTS "ls_status_idx"    ON "learning_signals" ("status");
CREATE INDEX IF NOT EXISTS "ls_created_idx"   ON "learning_signals" ("created_at");

CREATE TABLE IF NOT EXISTS "learning_patterns" (
  "id"            text PRIMARY KEY NOT NULL,
  "workspace_id"  text NOT NULL,
  "pattern_type"  text NOT NULL,
  "title"         text NOT NULL,
  "description"   text NOT NULL,
  "occurrences"   integer NOT NULL DEFAULT 1,
  "confidence"    real NOT NULL,
  "evidence"      jsonb NOT NULL DEFAULT '[]',
  "affected_ids"  jsonb NOT NULL DEFAULT '[]',
  "status"        text NOT NULL DEFAULT 'active',
  "first_seen_at" bigint NOT NULL,
  "last_seen_at"  bigint NOT NULL,
  "created_at"    bigint NOT NULL,
  "updated_at"    bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "lp_workspace_idx"  ON "learning_patterns" ("workspace_id");
CREATE INDEX IF NOT EXISTS "lp_type_idx"       ON "learning_patterns" ("pattern_type");
CREATE INDEX IF NOT EXISTS "lp_status_idx"     ON "learning_patterns" ("status");
CREATE INDEX IF NOT EXISTS "lp_confidence_idx" ON "learning_patterns" ("confidence");

CREATE TABLE IF NOT EXISTS "learning_insights" (
  "id"              text PRIMARY KEY NOT NULL,
  "workspace_id"    text NOT NULL,
  "title"           text NOT NULL,
  "body"            text NOT NULL,
  "category"        text NOT NULL,
  "confidence"      real NOT NULL,
  "evidence"        jsonb NOT NULL DEFAULT '[]',
  "action_required" boolean NOT NULL DEFAULT false,
  "approved"        boolean,
  "approved_by"     text,
  "approved_at"     bigint,
  "pattern_id"      text,
  "embedding"       vector(768),
  "status"          text NOT NULL DEFAULT 'pending_review',
  "created_at"      bigint NOT NULL,
  "updated_at"      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "li_workspace_idx"  ON "learning_insights" ("workspace_id");
CREATE INDEX IF NOT EXISTS "li_category_idx"   ON "learning_insights" ("category");
CREATE INDEX IF NOT EXISTS "li_status_idx"     ON "learning_insights" ("status");
CREATE INDEX IF NOT EXISTS "li_confidence_idx" ON "learning_insights" ("confidence");

CREATE TABLE IF NOT EXISTS "learning_feedback" (
  "id"                text PRIMARY KEY NOT NULL,
  "workspace_id"      text NOT NULL,
  "recommendation_id" text NOT NULL,
  "insight_id"        text,
  "action"            text NOT NULL,
  "outcome"           text,
  "outcome_notes"     text,
  "user_id"           text,
  "delta_metric"      real,
  "metric_name"       text,
  "created_at"        bigint NOT NULL,
  "updated_at"        bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "lf_workspace_idx" ON "learning_feedback" ("workspace_id");
CREATE INDEX IF NOT EXISTS "lf_rec_idx"       ON "learning_feedback" ("recommendation_id");
CREATE INDEX IF NOT EXISTS "lf_action_idx"    ON "learning_feedback" ("action");

CREATE TABLE IF NOT EXISTS "learning_scores" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "entity_type"  text NOT NULL,
  "entity_id"    text NOT NULL,
  "score_type"   text NOT NULL,
  "score_value"  real NOT NULL,
  "history"      jsonb NOT NULL DEFAULT '[]',
  "sample_count" integer NOT NULL DEFAULT 1,
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "lsc_workspace_idx" ON "learning_scores" ("workspace_id");
CREATE INDEX IF NOT EXISTS "lsc_entity_idx"    ON "learning_scores" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "lsc_type_idx"      ON "learning_scores" ("score_type");

CREATE TABLE IF NOT EXISTS "memory_embeddings" (
  "id"              text PRIMARY KEY NOT NULL,
  "workspace_id"    text NOT NULL,
  "memory_id"       text NOT NULL,
  "chunk_index"     integer NOT NULL DEFAULT 0,
  "chunk_text"      text NOT NULL,
  "embedding"       vector(768),
  "embedding_model" text NOT NULL DEFAULT 'nomic-embed-text',
  "is_stale"        boolean NOT NULL DEFAULT false,
  "created_at"      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "me_workspace_idx" ON "memory_embeddings" ("workspace_id");
CREATE INDEX IF NOT EXISTS "me_memory_idx"    ON "memory_embeddings" ("memory_id");
CREATE INDEX IF NOT EXISTS "me_stale_idx"     ON "memory_embeddings" ("is_stale");

CREATE TABLE IF NOT EXISTS "memory_clusters" (
  "id"               text PRIMARY KEY NOT NULL,
  "workspace_id"     text NOT NULL,
  "label"            text NOT NULL,
  "description"      text,
  "member_memory_ids" jsonb NOT NULL DEFAULT '[]',
  "centroid"         vector(768),
  "member_count"     integer NOT NULL DEFAULT 0,
  "created_at"       bigint NOT NULL,
  "updated_at"       bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "mc_workspace_idx" ON "memory_clusters" ("workspace_id");

CREATE TABLE IF NOT EXISTS "retrieval_logs" (
  "id"                  text PRIMARY KEY NOT NULL,
  "workspace_id"        text NOT NULL,
  "query"               text NOT NULL,
  "query_embedding"     vector(768),
  "memory_ids_returned" jsonb NOT NULL DEFAULT '[]',
  "scores"              jsonb NOT NULL DEFAULT '[]',
  "retrieval_type"      text NOT NULL DEFAULT 'hybrid',
  "latency_ms"          integer,
  "was_used"            boolean NOT NULL DEFAULT false,
  "used_by_run_id"      text,
  "created_at"          bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "rl_workspace_idx" ON "retrieval_logs" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rl_used_idx"      ON "retrieval_logs" ("was_used");
CREATE INDEX IF NOT EXISTS "rl_created_idx"   ON "retrieval_logs" ("created_at");

CREATE TABLE IF NOT EXISTS "recommendation_outcomes" (
  "id"                text PRIMARY KEY NOT NULL,
  "workspace_id"      text NOT NULL,
  "recommendation_id" text NOT NULL,
  "insight_id"        text,
  "outcome"           text NOT NULL,
  "delta_metric"      real,
  "metric_name"       text,
  "notes"             text,
  "executed_by"       text,
  "created_at"        bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "ro_workspace_idx" ON "recommendation_outcomes" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ro_rec_idx"       ON "recommendation_outcomes" ("recommendation_id");

CREATE TABLE IF NOT EXISTS "model_quality_scores" (
  "id"           text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "provider"     text NOT NULL,
  "model"        text NOT NULL,
  "task_type"    text NOT NULL,
  "score_value"  real NOT NULL,
  "sample_count" integer NOT NULL DEFAULT 1,
  "latency_p50"  real,
  "latency_p99"  real,
  "error_rate"   real NOT NULL DEFAULT 0,
  "history"      jsonb NOT NULL DEFAULT '[]',
  "created_at"   bigint NOT NULL,
  "updated_at"   bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS "mqs_workspace_idx" ON "model_quality_scores" ("workspace_id");
CREATE INDEX IF NOT EXISTS "mqs_provider_idx"  ON "model_quality_scores" ("provider", "model");
CREATE INDEX IF NOT EXISTS "mqs_task_idx"      ON "model_quality_scores" ("task_type");
