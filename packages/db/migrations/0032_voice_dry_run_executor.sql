-- 0032_voice_dry_run_executor.sql
-- Close the five voice dry-run gaps:
--   1. Server-side executor needs to know the original execute hook
--   2. Budget integration produces a structured decision per dry-run
--   3. (cron only — no schema change)
--   4. Conversation context tracks the pending dry-run id for spoken approval
--   5. Browser action plan is persisted in typed form alongside the preview

ALTER TABLE "voice_dry_runs"
  ADD COLUMN IF NOT EXISTS "execute_hook"          jsonb,        -- { method, path, body } captured at simulate-time
  ADD COLUMN IF NOT EXISTS "budget_decision"       jsonb,        -- { approved, blockReason, capId, guardId }
  ADD COLUMN IF NOT EXISTS "browser_action_plan"   jsonb,        -- typed BrowserActionPlan for the browser worker
  ADD COLUMN IF NOT EXISTS "executed_via"          text;          -- 'spoken' | 'ui' | 'server' — channel that triggered execute

ALTER TABLE "voice_session_context"
  ADD COLUMN IF NOT EXISTS "pending_dry_run_id" text;
