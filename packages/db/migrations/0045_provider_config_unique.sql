-- 0045_provider_config_unique.sql
--
-- Add a unique constraint on provider_configs(workspace_id, provider_id).
--
-- Why: chat-providers.configureProvider() did a SELECT-then-INSERT/UPDATE
-- with onConflictDoNothing() on the INSERT path. But onConflictDoNothing
-- only fires against an actual unique constraint — and none existed on
-- (workspace_id, provider_id), only the primary key `id` (a fresh uuid
-- that never collides). So two concurrent configureProvider() calls for
-- the same provider both passed the existence check and both INSERTed,
-- producing duplicate rows; later reads picked an arbitrary one.
--
-- With this constraint the INSERT can use a real ON CONFLICT DO UPDATE.
--
-- Idempotent: added only if absent. Deduplicates pre-existing rows first
-- (keeps the most-recently-updated row per pair) so the constraint can
-- be created without violation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'provider_configs_workspace_provider_uq'
  ) THEN
    -- Collapse any existing duplicates: keep the newest updated_at per
    -- (workspace_id, provider_id), delete the rest.
    DELETE FROM provider_configs a
    USING provider_configs b
    WHERE a.workspace_id = b.workspace_id
      AND a.provider_id  = b.provider_id
      AND a.updated_at   < b.updated_at;

    ALTER TABLE provider_configs
      ADD CONSTRAINT provider_configs_workspace_provider_uq
      UNIQUE (workspace_id, provider_id);
  END IF;
END $$;
