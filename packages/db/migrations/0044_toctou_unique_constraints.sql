-- 0044_toctou_unique_constraints.sql
--
-- Add unique constraints to eliminate TOCTOU races where services do
-- SELECT-then-INSERT/UPDATE under concurrency. Without these, two
-- concurrent callers can both pass the existence check and both INSERT
-- → duplicate rows. With these, the second INSERT fails the constraint
-- and the service can use ON CONFLICT DO UPDATE for atomic upsert.
--
-- Sites depending on these constraints (all switched to onConflictDoUpdate):
--   • agent_registrations(workspace_id, agent_name)
--       — packages/db/src/agent-heartbeat.ts
--   • content_analytics dedup uses memories(workspace_id, source_ref)
--       — apps/api/src/services/content-analytics.ts
--   • code_proposals(workspace_id, capability_id) WHERE status='proposed'
--       — apps/api/src/services/code-writer.ts
--   • failure_memory(workspace_id, signature)
--       — apps/api/src/services/failure-memory.ts
--
-- Idempotent: each constraint is added only if absent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_registrations_workspace_name_uq'
  ) THEN
    ALTER TABLE agent_registrations
      ADD CONSTRAINT agent_registrations_workspace_name_uq
      UNIQUE (workspace_id, agent_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'memories_workspace_source_ref_uq'
  ) THEN
    -- Only enforce on rows that actually have a source_ref. Memories
    -- without a source_ref are free-form and must not collide.
    CREATE UNIQUE INDEX IF NOT EXISTS memories_workspace_source_ref_uq
      ON memories (workspace_id, source_ref)
      WHERE source_ref IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'code_proposals_open_capability_uq'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS code_proposals_open_capability_uq
      ON code_proposals (workspace_id, capability_id)
      WHERE status = 'proposed' AND capability_id IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'failure_memory_workspace_signature_uq'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS failure_memory_workspace_signature_uq
      ON failure_memory (workspace_id, signature);
  END IF;
END $$;
