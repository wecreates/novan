-- 0020_commerce_creative_trust_governance.sql
-- Four-layer ship in one migration. All tables nullable-friendly + indexed.

-- ─── 1. Browser sessions + events ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "commerce_sessions" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "platform"       text NOT NULL,
  "account_ref"    text NOT NULL,
  "status"         text NOT NULL DEFAULT 'pending',
  "scopes"         jsonb NOT NULL DEFAULT '[]',
  "approval_id"    text,
  "events_count"   integer NOT NULL DEFAULT 0,
  "screenshots_taken" integer NOT NULL DEFAULT 0,
  "started_at"     bigint,
  "ended_at"       bigint,
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "csess_workspace_idx" ON "commerce_sessions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "csess_status_idx"    ON "commerce_sessions" ("status");

CREATE TABLE IF NOT EXISTS "commerce_events" (
  "id"               text PRIMARY KEY,
  "session_id"       text NOT NULL,
  "workspace_id"     text NOT NULL,
  "event_type"       text NOT NULL,
  "url"              text,
  "action_text"      text,
  "screenshot_path"  text,
  "requires_confirm" boolean NOT NULL DEFAULT false,
  "confirmed"        boolean NOT NULL DEFAULT false,
  "blocked_reason"   text,
  "occurred_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "cev_session_idx"   ON "commerce_events" ("session_id");
CREATE INDEX IF NOT EXISTS "cev_workspace_idx" ON "commerce_events" ("workspace_id");
CREATE INDEX IF NOT EXISTS "cev_occurred_idx"  ON "commerce_events" ("occurred_at");

-- ─── 2. Account credentials (refs vault) ────────────────────────────────
CREATE TABLE IF NOT EXISTS "account_credentials" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "platform"       text NOT NULL,   -- etsy | printify | redbubble | tiktok | instagram | x | midjourney | gmail | other
  "account_ref"    text NOT NULL,   -- operator-chosen handle (NOT the password)
  "vault_secret_id" text,            -- references secrets_vault — actual creds encrypted there
  "granted_scopes" jsonb NOT NULL DEFAULT '[]',
  "paused"         boolean NOT NULL DEFAULT false,
  "last_used_at"   bigint,
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ac_unique" ON "account_credentials" ("workspace_id", "platform", "account_ref");
CREATE INDEX IF NOT EXISTS "ac_workspace_idx" ON "account_credentials" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ac_platform_idx"  ON "account_credentials" ("platform");

-- ─── 3. POD listings + design concepts ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "design_concepts" (
  "id"               text PRIMARY KEY,
  "workspace_id"     text NOT NULL,
  "brief"            text NOT NULL,
  "prompt"           text NOT NULL,
  "asset_image_ref"  text,            -- references image_generations.id
  "originality_score" real,            -- 0..1 (higher = more original)
  "ip_risk_score"    real,            -- 0..1 (higher = more risk)
  "slop_score"       real,            -- 0..1 (lower = less slop)
  "quality_score"    real,            -- 0..1 (composite)
  "trend_refs"       jsonb NOT NULL DEFAULT '[]',
  "status"           text NOT NULL DEFAULT 'draft', -- draft | reviewed | approved | rejected | published
  "block_reasons"    jsonb NOT NULL DEFAULT '[]',
  "created_at"       bigint NOT NULL,
  "updated_at"       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "dc_workspace_idx" ON "design_concepts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "dc_status_idx"    ON "design_concepts" ("status");

CREATE TABLE IF NOT EXISTS "pod_listings" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "platform"       text NOT NULL,    -- etsy | printify | redbubble
  "concept_id"     text,
  "title"          text NOT NULL,
  "description"    text NOT NULL,
  "tags"           jsonb NOT NULL DEFAULT '[]',
  "asset_refs"     jsonb NOT NULL DEFAULT '[]',
  "external_id"    text,             -- platform listing id
  "status"         text NOT NULL DEFAULT 'draft', -- draft | approval_pending | live | paused | removed
  "quality_score"  real,
  "performance"    jsonb NOT NULL DEFAULT '{}',
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "pl_workspace_idx" ON "pod_listings" ("workspace_id");
CREATE INDEX IF NOT EXISTS "pl_platform_idx"  ON "pod_listings" ("platform");
CREATE INDEX IF NOT EXISTS "pl_status_idx"    ON "pod_listings" ("status");

-- ─── 4. Social posts ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "social_posts" (
  "id"             text PRIMARY KEY,
  "workspace_id"   text NOT NULL,
  "platform"       text NOT NULL,
  "account_ref"    text NOT NULL,
  "body"           text NOT NULL,
  "asset_refs"     jsonb NOT NULL DEFAULT '[]',
  "scheduled_at"   bigint,
  "posted_at"      bigint,
  "external_id"    text,
  "status"         text NOT NULL DEFAULT 'draft', -- draft | approval_pending | scheduled | posted | failed | blocked
  "approval_id"    text,
  "engagement"     jsonb NOT NULL DEFAULT '{}',
  "spam_score"     real,
  "block_reasons"  jsonb NOT NULL DEFAULT '[]',
  "created_at"     bigint NOT NULL,
  "updated_at"     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sp_workspace_idx" ON "social_posts" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sp_status_idx"    ON "social_posts" ("status");
CREATE INDEX IF NOT EXISTS "sp_platform_idx"  ON "social_posts" ("platform");

-- ─── 5. Trend findings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "trend_findings" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "source"        text NOT NULL,        -- google_trends | tiktok | reddit | research_agent | manual
  "niche"         text NOT NULL,
  "signal"        text NOT NULL,
  "score"         real NOT NULL DEFAULT 0,
  "confidence"    real NOT NULL DEFAULT 0,
  "citations"     jsonb NOT NULL DEFAULT '[]',
  "captured_at"   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "tf_workspace_idx" ON "trend_findings" ("workspace_id");
CREATE INDEX IF NOT EXISTS "tf_niche_idx"     ON "trend_findings" ("niche");
CREATE INDEX IF NOT EXISTS "tf_captured_idx"  ON "trend_findings" ("captured_at");

-- ─── 6. Trust scores ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "trust_scores" (
  "subject_type"  text NOT NULL,   -- agent | workflow | account | provider | content_pipeline
  "subject_id"    text NOT NULL,
  "workspace_id"  text NOT NULL,
  "score"         real NOT NULL DEFAULT 0.8,   -- 0..1
  "signals"       jsonb NOT NULL DEFAULT '[]',
  "updated_at"    bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "subject_type", "subject_id")
);
CREATE INDEX IF NOT EXISTS "ts_workspace_idx" ON "trust_scores" ("workspace_id");

-- ─── 7. Posting governor ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "posting_governor" (
  "workspace_id"     text NOT NULL,
  "platform"         text NOT NULL,
  "account_ref"      text NOT NULL,
  "posts_today"      integer NOT NULL DEFAULT 0,
  "max_per_day"      integer NOT NULL DEFAULT 5,
  "cooldown_min"     integer NOT NULL DEFAULT 45,
  "last_post_at"     bigint,
  "window_start"     bigint NOT NULL,
  "updated_at"       bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "platform", "account_ref")
);

-- ─── 8. Agent pause state (governance) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "agent_pause_state" (
  "workspace_id"  text NOT NULL,
  "agent_name"    text NOT NULL,
  "paused"        boolean NOT NULL DEFAULT false,
  "paused_by"     text,
  "paused_at"     bigint,
  "reason"        text,
  "updated_at"    bigint NOT NULL,
  PRIMARY KEY ("workspace_id", "agent_name")
);

-- ─── 9. Operator override log ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "override_log" (
  "id"               text PRIMARY KEY,
  "workspace_id"     text NOT NULL,
  "action_type"      text NOT NULL,
  "subject_id"       text,
  "original_status"  text NOT NULL,
  "override_status"  text NOT NULL,
  "operator_id"      text,
  "reason"           text,
  "created_at"       bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "ol_workspace_idx" ON "override_log" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ol_action_idx"    ON "override_log" ("action_type");
CREATE INDEX IF NOT EXISTS "ol_created_idx"   ON "override_log" ("created_at");

-- ─── 10. Ethical blocks (intent-rejection audit) ────────────────────────
CREATE TABLE IF NOT EXISTS "ethical_blocks" (
  "id"           text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "intent"       text NOT NULL,
  "source"       text NOT NULL,    -- agent name or 'operator'
  "category"     text NOT NULL,    -- intent | content | path | spam | ip | purchase | other
  "reason"       text NOT NULL,
  "blocked_at"   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "eb_workspace_idx" ON "ethical_blocks" ("workspace_id");
CREATE INDEX IF NOT EXISTS "eb_category_idx"  ON "ethical_blocks" ("category");
CREATE INDEX IF NOT EXISTS "eb_blocked_idx"   ON "ethical_blocks" ("blocked_at");
