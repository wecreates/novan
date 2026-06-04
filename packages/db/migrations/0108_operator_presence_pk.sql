-- R146.199 — operator_presence had no primary key. SELECT-then-INSERT in
-- recap.ts:getOrInitPresence is a textbook TOCTOU: two concurrent polls
-- could both observe "no row" and both INSERT, producing duplicates.
-- The composite (workspace_id, operator_id) IS the natural identity, so
-- promote it to PK. Table is empty in production, so PK creation is
-- safe (DELETE-then-PK would be needed otherwise). Drops the redundant
-- non-unique btree index since the PK implicitly creates an index on
-- the same columns.

ALTER TABLE operator_presence
  ADD CONSTRAINT operator_presence_pkey PRIMARY KEY (workspace_id, operator_id);

DROP INDEX IF EXISTS op_presence_idx;
