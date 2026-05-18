/**
 * brain-persistence.ts — saved_views CRUD + status_changes write helpers.
 *
 * Saved views replace localStorage-only persistence: now syncs across
 * devices for the same operator+workspace.
 *
 * Status history is event-sourcing-lite for replay fidelity: services
 * that change a node's status call recordStatusChange() so replayAt
 * can return historically-accurate status (not just current-state).
 */
import { db } from '../db/client.js'
import { savedViews, statusChanges } from '../db/schema.js'
import { and, eq, desc, lte } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'

// ─── Saved views ────────────────────────────────────────────────────────

export interface SavedView {
  id:             string
  workspaceId:    string
  operatorId:     string | null
  name:           string
  template:       string
  focusSystem:    string | null
  cameraPosition: { x: number; y: number; z: number; tx: number; ty: number; tz: number } | null
  lod:            string
  createdAt:      number
  updatedAt:      number
}

export async function saveView(input: {
  workspaceId: string
  operatorId?: string
  name: string
  template: string
  focusSystem?: string | null
  cameraPosition?: SavedView['cameraPosition']
  lod?: string
}): Promise<string> {
  const id = uuidv7(), now = Date.now()
  await db.insert(savedViews).values({
    id, workspaceId: input.workspaceId,
    operatorId: input.operatorId ?? null,
    name: input.name.slice(0, 80),
    template: input.template,
    focusSystem: input.focusSystem ?? null,
    cameraPosition: input.cameraPosition ?? null,
    lod: input.lod ?? 'systems',
    createdAt: now, updatedAt: now,
  }).catch(() => null)
  return id
}

export async function listSavedViews(workspaceId: string, limit = 20) {
  return db.select().from(savedViews)
    .where(eq(savedViews.workspaceId, workspaceId))
    .orderBy(desc(savedViews.updatedAt))
    .limit(limit).catch(() => [])
}

export async function deleteSavedView(workspaceId: string, id: string): Promise<void> {
  await db.delete(savedViews)
    .where(and(eq(savedViews.workspaceId, workspaceId), eq(savedViews.id, id)))
    .catch(() => null)
}

// ─── Status history ─────────────────────────────────────────────────────

export type StatusEntityType = 'agent' | 'proposal' | 'drift' | 'kill_switch' | 'provider'

export async function recordStatusChange(input: {
  workspaceId: string
  entityType:  StatusEntityType
  entityId:    string
  status:      string
  source:      string
  metadata?:   Record<string, unknown>
}): Promise<void> {
  await db.insert(statusChanges).values({
    id: uuidv7(),
    workspaceId: input.workspaceId,
    entityType: input.entityType,
    entityId: input.entityId,
    status: input.status,
    source: input.source,
    changedAt: Date.now(),
    metadata: input.metadata ?? {},
  }).catch(() => null)
}

/**
 * Returns the status that was current for an entity at a given timestamp,
 * or null if no history exists before that point.
 */
export async function statusAt(workspaceId: string, entityType: StatusEntityType, entityId: string, at: number): Promise<string | null> {
  const row = await db.select().from(statusChanges)
    .where(and(
      eq(statusChanges.workspaceId, workspaceId),
      eq(statusChanges.entityType, entityType),
      eq(statusChanges.entityId, entityId),
      lte(statusChanges.changedAt, at),
    ))
    .orderBy(desc(statusChanges.changedAt))
    .limit(1).then(r => r[0]).catch(() => null)
  return row?.status ?? null
}

/**
 * Bulk: status at time T for all entities of a type. Used by replayAt
 * to enrich every node in one query.
 */
export async function bulkStatusAt(workspaceId: string, entityType: StatusEntityType, at: number): Promise<Map<string, string>> {
  const rows = await db.select().from(statusChanges)
    .where(and(
      eq(statusChanges.workspaceId, workspaceId),
      eq(statusChanges.entityType, entityType),
      lte(statusChanges.changedAt, at),
    ))
    .orderBy(desc(statusChanges.changedAt))
    .limit(5000).catch(() => [])
  // First occurrence (most recent before T) wins per entity
  const out = new Map<string, string>()
  for (const r of rows) {
    if (out.has(r.entityId)) continue
    out.set(r.entityId, r.status)
  }
  return out
}
