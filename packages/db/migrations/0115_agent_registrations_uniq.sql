-- R146.222 — Enable atomic upsert for agent_registrations heartbeats.
-- Telemetry showed 29 314 updates over 6 days on 43 logical rows
-- (~681 per row, ~113/day) because agent-state-sync.selfRegister did
-- SELECT-then-(UPDATE-or-INSERT). Adding the unique constraint lets
-- the caller switch to a single INSERT...ON CONFLICT DO UPDATE with
-- a setWhere clause that skips no-op writes when capabilities + status
-- are unchanged AND the previous heartbeat is fresh (<60s).

CREATE UNIQUE INDEX IF NOT EXISTS agent_registrations_ws_name_uniq
  ON agent_registrations (workspace_id, agent_name);
