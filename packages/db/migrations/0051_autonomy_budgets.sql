-- R146.97 — autonomy budgets.
-- Operator sets "spend up to $X/day per business without asking" and the
-- brain respects the budget. Below threshold = autonomous; above = approval
-- required. Tracks period spend per (workspace, business, category).

CREATE TABLE IF NOT EXISTS autonomy_budgets (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id     text REFERENCES businesses(id) ON DELETE CASCADE,  -- NULL = workspace-wide
  category        text NOT NULL,                -- 'ads' | 'content-gen' | 'data' | 'all'
  period          text NOT NULL,                -- 'daily' | 'weekly' | 'monthly'
  ceiling_usd     numeric NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      bigint NOT NULL,
  updated_at      bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomy_budgets_ws_idx ON autonomy_budgets(workspace_id);
CREATE INDEX IF NOT EXISTS autonomy_budgets_biz_idx ON autonomy_budgets(business_id);

-- Append-only ledger of every autonomous spend the brain takes
CREATE TABLE IF NOT EXISTS autonomy_spend_log (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_id     text REFERENCES businesses(id) ON DELETE SET NULL,
  category        text NOT NULL,
  amount_usd      numeric NOT NULL,
  op              text NOT NULL,        -- which brain-task op triggered it
  reason          text,                 -- short rationale
  recorded_at     bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS autonomy_spend_log_ws_cat_idx ON autonomy_spend_log(workspace_id, category, recorded_at);
CREATE INDEX IF NOT EXISTS autonomy_spend_log_biz_idx ON autonomy_spend_log(business_id, recorded_at);
