-- 0016_autonomy_completion.sql
-- Tier 1-3 gap closure: action dispatch, revenue ingestion, rec feedback,
-- inbound signals, strategic horizons, cron budgets.

-- ─── 1. Action execution layer ────────────────────────────────────────────
-- Generic dispatchable actions. Type determines payload shape; dispatcher
-- routes to a handler. High-risk types gate through approval_gate.
CREATE TABLE IF NOT EXISTS "actions" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "type"          text NOT NULL,        -- swap_provider | throttle_queue | send_message | cancel_worker | notify_operator | record_decision
  "subject_id"    text,                  -- recommendation id, worker id, etc.
  "payload"       jsonb NOT NULL DEFAULT '{}',
  "status"        text NOT NULL DEFAULT 'pending',  -- pending | approved | executing | succeeded | failed | rejected | cancelled
  "risk_level"    text NOT NULL DEFAULT 'low',      -- low | medium | high | critical
  "requested_by"  text NOT NULL,
  "approval_id"   text,                  -- nullable; populated when gated
  "result"        jsonb,
  "error"         text,
  "created_at"    bigint NOT NULL,
  "started_at"    bigint,
  "completed_at"  bigint
);
CREATE INDEX IF NOT EXISTS "actions_workspace_idx" ON "actions" ("workspace_id");
CREATE INDEX IF NOT EXISTS "actions_status_idx"    ON "actions" ("status");
CREATE INDEX IF NOT EXISTS "actions_type_idx"      ON "actions" ("type");
CREATE INDEX IF NOT EXISTS "actions_created_idx"   ON "actions" ("created_at");

-- ─── 2. Revenue events ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "revenue_events" (
  "id"              text PRIMARY KEY,
  "workspace_id"    text NOT NULL,
  "source"          text NOT NULL,         -- stripe | manual | api | other
  "amount_usd"      real NOT NULL,
  "currency"        text NOT NULL DEFAULT 'USD',
  "customer_ref"    text,
  "workflow_run_id" text,                   -- attribution: which workflow generated this
  "occurred_at"     bigint NOT NULL,
  "metadata"        jsonb NOT NULL DEFAULT '{}',
  "created_at"      bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "rev_workspace_idx"  ON "revenue_events" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rev_occurred_idx"   ON "revenue_events" ("occurred_at");
CREATE INDEX IF NOT EXISTS "rev_workflow_idx"   ON "revenue_events" ("workflow_run_id");

-- ─── 3. Recommendation feedback ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "recommendation_feedback" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "chain_id"      text NOT NULL,            -- references reasoning_chains.id
  "action"        text NOT NULL,            -- accept | reject | snooze | noop
  "reason"        text,
  "operator_id"   text,
  "weight_delta"  real NOT NULL DEFAULT 0,  -- contribution to future scoring (+ for accept, − for reject)
  "created_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "rf_workspace_idx" ON "recommendation_feedback" ("workspace_id");
CREATE INDEX IF NOT EXISTS "rf_chain_idx"     ON "recommendation_feedback" ("chain_id");
CREATE INDEX IF NOT EXISTS "rf_action_idx"    ON "recommendation_feedback" ("action");

-- ─── 7. Inbound messages (Slack/email webhook target) ───────────────────
CREATE TABLE IF NOT EXISTS "inbound_messages" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "channel"       text NOT NULL,        -- email | slack | discord | sms | webhook
  "external_id"   text,                  -- upstream message id for dedupe
  "from_addr"     text,
  "subject"       text,
  "body"          text NOT NULL,
  "received_at"   bigint NOT NULL,
  "processed_at"  bigint,
  "intent"        text,                  -- classified post-receipt: question | task | fyi | alert
  "metadata"      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "ib_workspace_idx"   ON "inbound_messages" ("workspace_id");
CREATE INDEX IF NOT EXISTS "ib_channel_idx"     ON "inbound_messages" ("channel");
CREATE INDEX IF NOT EXISTS "ib_received_idx"    ON "inbound_messages" ("received_at");
CREATE UNIQUE INDEX IF NOT EXISTS "ib_external_unique" ON "inbound_messages" ("workspace_id", "channel", "external_id") WHERE "external_id" IS NOT NULL;

-- ─── 8. Strategic horizons (90d / 1y planning) ──────────────────────────
CREATE TABLE IF NOT EXISTS "strategic_horizons" (
  "id"            text PRIMARY KEY,
  "workspace_id"  text NOT NULL,
  "horizon"       text NOT NULL,        -- 90d | 180d | 1y | 3y
  "title"         text NOT NULL,
  "objectives"    jsonb NOT NULL DEFAULT '[]',     -- [{ id, statement, metric, target, currentValue, status }]
  "constraints"   jsonb NOT NULL DEFAULT '[]',
  "review_at"     bigint NOT NULL,                  -- when to revisit
  "status"        text NOT NULL DEFAULT 'active',   -- active | paused | retired
  "created_at"    bigint NOT NULL,
  "updated_at"    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "sh_workspace_idx" ON "strategic_horizons" ("workspace_id");
CREATE INDEX IF NOT EXISTS "sh_horizon_idx"   ON "strategic_horizons" ("horizon");
CREATE INDEX IF NOT EXISTS "sh_status_idx"    ON "strategic_horizons" ("status");

-- ─── 12. Cron budgets (per-cron token/call ceilings) ────────────────────
CREATE TABLE IF NOT EXISTS "cron_budgets" (
  "id"             text PRIMARY KEY,
  "cron_name"      text NOT NULL,
  "window_start"   bigint NOT NULL,         -- start of current accounting window
  "calls_used"     integer NOT NULL DEFAULT 0,
  "tokens_used"    integer NOT NULL DEFAULT 0,
  "cost_usd_used"  real NOT NULL DEFAULT 0,
  "max_calls"      integer NOT NULL DEFAULT 1000,
  "max_tokens"     integer NOT NULL DEFAULT 1000000,
  "max_cost_usd"   real NOT NULL DEFAULT 5.0,
  "window_ms"      bigint NOT NULL DEFAULT 3600000,
  "blocked"        boolean NOT NULL DEFAULT false,
  "last_blocked_at" bigint,
  "updated_at"     bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "cb_name_unique" ON "cron_budgets" ("cron_name");
