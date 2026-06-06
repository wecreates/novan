-- R146.325 (#23) — soft-delete column on workspaces.
-- The FK chain workspaces → events/messages/ai_usage uses ON DELETE CASCADE,
-- which means `DELETE FROM workspaces WHERE id=$1` wipes years of audit
-- history irreversibly. Soft-delete sets `archived_at`; row + FKs survive,
-- but query helpers (added in services) filter them out by default.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS archived_at bigint;
CREATE INDEX IF NOT EXISTS workspaces_archived_at_idx ON workspaces (archived_at) WHERE archived_at IS NOT NULL;
