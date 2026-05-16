/**
 * Snapshot item builder — records the "before state" of each entity
 * that a rollback step might need to restore.
 *
 * itemType: 'db_row' | 'file' | 'api_state' | 'custom'
 */
import { db }            from '../db.js'
import { snapshotItems } from '@ops/db'
import { eq }            from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

export interface SnapshotItemInput {
  snapshotId:  string
  workspaceId: string
  itemType:    'db_row' | 'file' | 'api_state' | 'custom'
  entityType:  string
  entityId:    string
  beforeState: Record<string, unknown>
  metadata?:   Record<string, unknown>
}

export async function addSnapshotItem(input: SnapshotItemInput): Promise<string> {
  const id = uuidv7()
  await db.insert(snapshotItems).values({
    id,
    snapshotId:  input.snapshotId,
    workspaceId: input.workspaceId,
    itemType:    input.itemType,
    entityType:  input.entityType,
    entityId:    input.entityId,
    beforeState: input.beforeState,
    metadata:    input.metadata ?? {},
    createdAt:   Date.now(),
  })
  return id
}

export async function getSnapshotItems(snapshotId: string): Promise<typeof snapshotItems.$inferSelect[]> {
  return db.select().from(snapshotItems).where(eq(snapshotItems.snapshotId, snapshotId))
}
