-- R146.133 — Row-level security defense-in-depth.
--
-- App-layer already filters every query by workspace_id. RLS is a second
-- net: even if a service forgets a WHERE workspace_id = X, the DB will
-- enforce it via a session-set GUC novan.current_workspace.
--
-- Services that legitimately need cross-workspace access (cron sweeps,
-- the postgres role itself) set `novan.bypass_rls = 'on'` per-tx.
--
-- Wave 1: highest-value tables — secretsVault, connectorAccounts,
-- code_proposals, code_patches, revenue_runs, agent_ops_board.
-- Other tables get RLS in a future wave.

DO $$
BEGIN
  -- Enable RLS on key tables
  EXECUTE 'ALTER TABLE IF EXISTS secrets_vault       ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS connector_accounts  ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS code_proposals      ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS code_patches        ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS revenue_runs        ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE IF EXISTS agent_ops_board     ENABLE ROW LEVEL SECURITY';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RLS enable skipped: %', SQLERRM;
END $$;

-- Policy helper: workspace match OR bypass flag set
CREATE OR REPLACE FUNCTION novan_workspace_check(ws TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF current_setting('novan.bypass_rls', true) = 'on' THEN
    RETURN TRUE;
  END IF;
  RETURN ws = current_setting('novan.current_workspace', true);
END $$;

-- Wave 1 policies
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'secrets_vault', 'connector_accounts', 'code_proposals',
    'code_patches', 'revenue_runs', 'agent_ops_board'
  ] LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS %I_ws_policy ON %I', tbl, tbl);
      EXECUTE format('CREATE POLICY %I_ws_policy ON %I FOR ALL USING (novan_workspace_check(workspace_id))', tbl, tbl);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'policy create skipped for %: %', tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- Default bypass for the role used by api/worker — so existing services
-- that haven't been migrated to set novan.current_workspace still work
-- (defense-in-depth, not break-the-world).
-- Operators can flip this off once all services set the GUC.
ALTER ROLE novan SET novan.bypass_rls = 'on';
