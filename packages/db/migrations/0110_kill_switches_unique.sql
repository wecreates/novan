-- R146.203 — kill_switches had no unique constraint on
-- (workspace_id, switch_type). action-dispatcher.ts:enableKillSwitch
-- and governance-core.ts:enableKillSwitch both do SELECT-then-INSERT;
-- two concurrent emergency triggers for the same (ws, type) could both
-- observe "no row" and both INSERT, producing duplicate kill records
-- where the second INSERT's state would conflict with the first's.
--
-- Adding a unique constraint at the DB level. Both code paths already
-- use a `.catch(...)` so the upsert hits the existing-row branch when
-- the constraint fires — the index just makes the safety unambiguous.

CREATE UNIQUE INDEX IF NOT EXISTS kill_switches_ws_type_uniq
  ON kill_switches (workspace_id, switch_type);
