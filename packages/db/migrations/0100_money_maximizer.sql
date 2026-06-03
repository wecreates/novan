-- R146.180 — Money-maximizer: rank every opportunity by $/hr, allocate effort.

CREATE TABLE IF NOT EXISTS money_opportunity (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  business_id         text,
  kind                text NOT NULL,            -- publish_post | win_back | new_product |
                                                 -- improve_listing | answer_comments |
                                                 -- fix_funnel_leak | upsell_whale | seo_article |
                                                 -- repurpose_topwin | reduce_refund
  title               text NOT NULL,
  est_revenue_lift_cents integer NOT NULL DEFAULT 0,
  est_hours           real NOT NULL DEFAULT 1,
  est_cost_cents      integer NOT NULL DEFAULT 0,
  dollars_per_hour    real NOT NULL DEFAULT 0,
  confidence          real NOT NULL DEFAULT 0.5,
  evidence            jsonb NOT NULL DEFAULT '{}',
  source              text NOT NULL,            -- which scanner found it
  payload             jsonb NOT NULL DEFAULT '{}', -- what executeNext needs
  status              text NOT NULL DEFAULT 'open', -- open | scheduled | running | done | skipped | failed
  scheduled_at        bigint,
  completed_at        bigint,
  actual_revenue_cents integer,
  created_at          bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS mo_ws_idx ON money_opportunity(workspace_id, status, dollars_per_hour DESC);
CREATE INDEX IF NOT EXISTS mo_ws_created_idx ON money_opportunity(workspace_id, created_at DESC);
