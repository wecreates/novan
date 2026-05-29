/**
 * world-model.ts — unified entity graph the Brain reasons over.
 *
 * Every "thing" the brain cares about (business, product, workflow,
 * connector, agent, channel, schedule, person, market) becomes a node.
 * Every "relates-to / depends-on / affects / blocks" becomes an edge.
 *
 * The model is queried by emergent-strategy, war-gaming, digital-twin,
 * and the recap system. Persisted in a single JSONB table for portability.
 */

import { db } from '../db/client.js'
import { sql } from 'drizzle-orm'

export type NodeKind =
  | 'business' | 'product' | 'workflow' | 'connector' | 'agent'
  | 'channel' | 'schedule' | 'person' | 'market' | 'platform'
  | 'infrastructure' | 'goal' | 'opportunity' | 'risk' | 'event'

export type EdgeKind =
  | 'depends_on' | 'affects' | 'blocks' | 'enables' | 'feeds'
  | 'competes_with' | 'monetizes' | 'powers' | 'reports_to' | 'derives_from'

export interface WorldNode {
  id: string
  workspaceId: string
  kind: NodeKind
  label: string
  attrs: Record<string, unknown>
  health: number          // 0..1
  importance: number      // 0..1
  updatedAt: number
}

export interface WorldEdge {
  id: string
  workspaceId: string
  fromId: string
  toId: string
  kind: EdgeKind
  weight: number          // 0..1; higher = stronger causal link
  attrs?: Record<string, unknown>
  updatedAt: number
}

let _ensured = false
async function ensure(): Promise<void> {
  if (_ensured) return
  // SECURITY/CORRECTNESS: PK is COMPOSITE (workspace_id, id) so two
  // workspaces can both have a node id like 'channel:main' without
  // cross-workspace data corruption. Previously the simple-id PK caused
  // ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id
  // to silently re-parent nodes between workspaces.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS world_nodes (
      id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      attrs JSONB NOT NULL DEFAULT '{}'::jsonb,
      health REAL NOT NULL DEFAULT 1.0,
      importance REAL NOT NULL DEFAULT 0.5,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    )`)
  // Edges deduped by (workspace_id, from_id, to_id, kind) so re-running
  // auto-population doesn't bloat the graph with duplicate edges.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS world_edges (
      id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
      workspace_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.5,
      attrs JSONB,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, from_id, to_id, kind)
    )`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wn_ws_kind ON world_nodes (workspace_id, kind)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS wn_ws_importance ON world_nodes (workspace_id, importance DESC)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS we_ws_from ON world_edges (workspace_id, from_id)`)
  await db.execute(sql`CREATE INDEX IF NOT EXISTS we_ws_to ON world_edges (workspace_id, to_id)`)
  _ensured = true
}

export async function upsertNode(n: Omit<WorldNode, 'updatedAt'> & { updatedAt?: number }): Promise<void> {
  await ensure()
  if (!n.id || !n.workspaceId) throw new Error('upsertNode: id + workspaceId required')
  const ts = n.updatedAt ?? Date.now()
  await db.execute(sql`
    INSERT INTO world_nodes (id, workspace_id, kind, label, attrs, health, importance, updated_at)
    VALUES (${n.id}, ${n.workspaceId}, ${n.kind}, ${n.label}, ${JSON.stringify(n.attrs)}::jsonb, ${n.health}, ${n.importance}, ${ts})
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      kind = EXCLUDED.kind, label = EXCLUDED.label, attrs = EXCLUDED.attrs,
      health = EXCLUDED.health, importance = EXCLUDED.importance,
      updated_at = EXCLUDED.updated_at`)
}

export async function upsertEdge(e: Omit<WorldEdge, 'updatedAt'> & { updatedAt?: number }): Promise<void> {
  await ensure()
  if (!e.workspaceId || !e.fromId || !e.toId || !e.kind) throw new Error('upsertEdge: workspaceId, fromId, toId, kind all required')
  const ts = e.updatedAt ?? Date.now()
  // Dedup by (workspace_id, from_id, to_id, kind) — multiple calls with
  // the same edge no longer create duplicate rows.
  await db.execute(sql`
    INSERT INTO world_edges (workspace_id, from_id, to_id, kind, weight, attrs, updated_at)
    VALUES (${e.workspaceId}, ${e.fromId}, ${e.toId}, ${e.kind}, ${e.weight}, ${e.attrs ? JSON.stringify(e.attrs) : null}::jsonb, ${ts})
    ON CONFLICT (workspace_id, from_id, to_id, kind) DO UPDATE SET
      weight = EXCLUDED.weight, attrs = EXCLUDED.attrs, updated_at = EXCLUDED.updated_at`)
}

export async function neighbors(workspaceId: string, nodeId: string, depth = 1): Promise<{ nodes: WorldNode[]; edges: WorldEdge[] }> {
  await ensure()
  const seen = new Set<string>([nodeId])
  const nodes: WorldNode[] = []
  const edges: WorldEdge[] = []
  let frontier = [nodeId]
  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break
    const rows = await db.execute(sql`
      SELECT id, workspace_id, from_id, to_id, kind, weight, attrs, updated_at
      FROM world_edges WHERE workspace_id = ${workspaceId} AND (from_id = ANY(${frontier}) OR to_id = ANY(${frontier}))`)
    const list = (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []
    const next: string[] = []
    for (const r of list) {
      const edge: WorldEdge = {
        id: String(r['id']), workspaceId: String(r['workspace_id']),
        fromId: String(r['from_id']), toId: String(r['to_id']),
        kind: r['kind'] as EdgeKind, weight: Number(r['weight']),
        updatedAt: Number(r['updated_at']),
      }
      edges.push(edge)
      for (const id of [edge.fromId, edge.toId]) if (!seen.has(id)) { seen.add(id); next.push(id) }
    }
    frontier = next
  }
  if (seen.size > 0) {
    const ids = Array.from(seen)
    const rows = await db.execute(sql`
      SELECT id, workspace_id, kind, label, attrs, health, importance, updated_at
      FROM world_nodes WHERE workspace_id = ${workspaceId} AND id = ANY(${ids})`)
    for (const r of (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      nodes.push({
        id: String(r['id']), workspaceId: String(r['workspace_id']),
        kind: r['kind'] as NodeKind, label: String(r['label']),
        attrs: r['attrs'] as Record<string, unknown>,
        health: Number(r['health']), importance: Number(r['importance']),
        updatedAt: Number(r['updated_at']),
      })
    }
  }
  return { nodes, edges }
}

export async function listNodes(workspaceId: string, kind?: NodeKind): Promise<WorldNode[]> {
  await ensure()
  const rows = await db.execute(kind
    ? sql`SELECT * FROM world_nodes WHERE workspace_id = ${workspaceId} AND kind = ${kind} ORDER BY importance DESC LIMIT 200`
    : sql`SELECT * FROM world_nodes WHERE workspace_id = ${workspaceId} ORDER BY importance DESC LIMIT 500`)
  return ((rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(r => ({
    id: String(r['id']), workspaceId: String(r['workspace_id']),
    kind: r['kind'] as NodeKind, label: String(r['label']),
    attrs: r['attrs'] as Record<string, unknown>,
    health: Number(r['health']), importance: Number(r['importance']),
    updatedAt: Number(r['updated_at']),
  }))
}

/**
 * Causality: for a given node, find what affects it (incoming edges) and
 * what it affects (outgoing). Used by war-gaming to identify blast radius.
 */
export async function causalChain(workspaceId: string, nodeId: string, direction: 'upstream' | 'downstream' = 'downstream', depth = 3): Promise<WorldNode[]> {
  await ensure()
  const seen = new Set<string>([nodeId])
  const result: WorldNode[] = []
  let frontier = [nodeId]
  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break
    const rows = await db.execute(direction === 'downstream'
      ? sql`SELECT to_id AS next FROM world_edges WHERE workspace_id = ${workspaceId} AND from_id = ANY(${frontier}) AND kind IN ('affects', 'enables', 'feeds', 'powers')`
      : sql`SELECT from_id AS next FROM world_edges WHERE workspace_id = ${workspaceId} AND to_id = ANY(${frontier}) AND kind IN ('affects', 'enables', 'feeds', 'powers', 'depends_on')`)
    const next: string[] = []
    for (const r of (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      const id = String(r['next'])
      if (!seen.has(id)) { seen.add(id); next.push(id) }
    }
    frontier = next
  }
  if (seen.size > 1) {
    const ids = Array.from(seen).filter(i => i !== nodeId)
    const rows = await db.execute(sql`SELECT * FROM world_nodes WHERE id = ANY(${ids})`)
    for (const r of (rows as unknown as { rows?: Array<Record<string, unknown>> }).rows ?? []) {
      result.push({
        id: String(r['id']), workspaceId: String(r['workspace_id']),
        kind: r['kind'] as NodeKind, label: String(r['label']),
        attrs: r['attrs'] as Record<string, unknown>,
        health: Number(r['health']), importance: Number(r['importance']),
        updatedAt: Number(r['updated_at']),
      })
    }
  }
  return result
}
