-- 0043_system_workspaces.sql
--
-- Seeds two reserved workspace rows that platform-wide code requires.
--
-- Why: many crons + the recovery-worker emit events with workspace_id
-- = 'system' (platform health, recovery health-check) or 'global'
-- (cross-workspace cron completions). The events.workspace_id FK
-- references workspaces.id, so without these rows present, every such
-- emit fails with `events_workspace_id_workspaces_id_fk` violations.
--
-- Discovered by booting recovery-worker for the first time against a
-- real DB — see worker logs:
--   "Failed to persist recovery event: recovery.health-check.completed
--    insert or update on table events violates foreign key constraint"
--
-- Idempotent: ON CONFLICT DO NOTHING. Safe to re-apply.

INSERT INTO workspaces (id, name, slug, plan, owner_id, settings, created_at, updated_at)
VALUES
  ('system', 'System (platform events)',  'system', 'free', 'system',
   '{}'::jsonb,
   (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
   (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
  ('global', 'Global (cross-workspace cron)', 'global', 'free', 'system',
   '{}'::jsonb,
   (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
   (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
