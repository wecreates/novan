/**
 * world-graph.ts — projects existing FK relationships into a unified
 * edge table.
 *
 * Two responsibilities:
 *
 *   1. POPULATE — walk source tables, extract their FK columns, write
 *      typed edges into `entity_relationships`. Idempotent: same edge
 *      gets upserted, never duplicated. Stale edges (where the source
 *      FK is now null) get pruned.
 *
 *   2. QUERY — given an entity (kind + id), return:
 *        - direct neighbors (1-hop both directions)
 *        - subgraph (≤ N hops, bounded fan-out)
 *      Used by UI to answer "what does this issue touch?"
 *
 * Honest scope:
 *   - Every edge is FK-derived (confidence: 1.0). No semantic inference,
 *     no LLM-suggested links. The graph is a projection of real data.
 *   - Adding a new edge source = one block in `collectEdges()` that
 *     queries a table and returns rows-as-edges.
 *   - Bounded fan-out on traversal (default ≤50 per node) prevents
 *     hot-node hairballs from blowing up responses.
 */
import { v7 as uuidv7 } from 'uuid'
import { and, desc, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  entityRelationships,
  issues, ideas, codeProposals, codePatches, businesses, businessSystems,
  incidents, connectorActions, connectorAccounts, events,
} from '../db/schema.js'

export type EntityKind =
  | 'issue' | 'idea' | 'proposal' | 'patch' | 'business' | 'business-system'
  | 'incident' | 'action' | 'account'

export interface Edge {
  sourceKind:   EntityKind | string
  sourceId:     string
  targetKind:   EntityKind | string
  targetId:     string
  relationship: string
  evidence:     Record<string, unknown>
  confidence?:  number
}

// ── Edge collectors ────────────────────────────────────────────────────
//
// Each collector reads ONE source table, returns the edges it implies.
// No DB writes here — pure projection. The populator runs all collectors,
// dedups by (sourceKind, sourceId, targetKind, targetId, relationship),
// and upserts.

async function collectIssueEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(issues).where(eq(issues.workspaceId, workspaceId)).catch(() => [])
  const out: Edge[] = []
  for (const i of rows) {
    if (i.proposalId) out.push({
      sourceKind: 'issue', sourceId: i.id, targetKind: 'proposal', targetId: i.proposalId,
      relationship: 'spawned-proposal', evidence: { via: 'issues.proposalId', at: i.updatedAt },
    })
    if (i.patchId) out.push({
      sourceKind: 'issue', sourceId: i.id, targetKind: 'patch', targetId: i.patchId,
      relationship: 'patched-by', evidence: { via: 'issues.patchId', at: i.updatedAt },
    })
    if (i.sourceIncidentId) out.push({
      sourceKind: 'incident', sourceId: i.sourceIncidentId, targetKind: 'issue', targetId: i.id,
      relationship: 'triggered-issue', evidence: { via: 'issues.sourceIncidentId', at: i.detectedAt },
    })
  }
  return out
}

async function collectIdeaEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(ideas).where(eq(ideas.workspaceId, workspaceId)).catch(() => [])
  const out: Edge[] = []
  for (const idea of rows) {
    if (idea.promotedToBusinessId) out.push({
      sourceKind: 'idea', sourceId: idea.id, targetKind: 'business', targetId: idea.promotedToBusinessId,
      relationship: 'promoted-to', evidence: { via: 'ideas.promotedToBusinessId', at: idea.promotedAt ?? idea.updatedAt },
    })
  }
  return out
}

async function collectProposalEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(codeProposals).where(eq(codeProposals.workspaceId, workspaceId)).catch(() => [])
  const out: Edge[] = []
  // proposal → patch via codePatches.proposalId (collected from patch side below)
  for (const p of rows) {
    if (p.capabilityId?.startsWith('issue:')) {
      // Reciprocal: proposal was auto-spawned from an issue
      const issueId = p.capabilityId.slice('issue:'.length)
      out.push({
        sourceKind: 'proposal', sourceId: p.id, targetKind: 'issue', targetId: issueId,
        relationship: 'addresses-issue', evidence: { via: 'codeProposals.capabilityId', at: p.createdAt },
      })
    }
  }
  return out
}

async function collectPatchEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(codePatches).where(eq(codePatches.workspaceId, workspaceId)).catch(() => [])
  return rows.map(p => ({
    sourceKind: 'proposal', sourceId: p.proposalId, targetKind: 'patch', targetId: p.id,
    relationship: 'built-into', evidence: { via: 'codePatches.proposalId', at: p.createdAt },
  } as Edge))
}

async function collectBusinessSystemEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(businessSystems).where(eq(businessSystems.workspaceId, workspaceId)).catch(() => [])
  return rows.map(b => ({
    sourceKind: 'business-system', sourceId: b.id, targetKind: 'business', targetId: b.businessId,
    relationship: 'belongs-to', evidence: { via: 'businessSystems.businessId', at: b.createdAt },
  } as Edge))
}

async function collectConnectorActionEdges(workspaceId: string): Promise<Edge[]> {
  const rows = await db.select().from(connectorActions).where(eq(connectorActions.workspaceId, workspaceId)).limit(500).catch(() => [])
  return rows.map(a => ({
    sourceKind: 'action', sourceId: a.id, targetKind: 'account', targetId: a.accountId,
    relationship: 'executed-on', evidence: { via: 'connectorActions.accountId', at: a.createdAt },
  } as Edge))
}

// ── Populator ─────────────────────────────────────────────────────────

export interface PopulateResult {
  inserted: number
  unchanged: number
  pruned:   number
}

export async function populateWorldGraph(workspaceId: string): Promise<PopulateResult> {
  const collectors = [
    collectIssueEdges, collectIdeaEdges, collectProposalEdges,
    collectPatchEdges, collectBusinessSystemEdges, collectConnectorActionEdges,
  ]
  const collected = (await Promise.all(collectors.map(c => c(workspaceId)))).flat()

  // Dedup within this run
  const wantKey = (e: Edge) => `${e.sourceKind}:${e.sourceId}|${e.relationship}|${e.targetKind}:${e.targetId}`
  const want = new Map<string, Edge>()
  for (const e of collected) want.set(wantKey(e), e)

  // Load existing edges for this workspace
  const existing = await db.select().from(entityRelationships)
    .where(eq(entityRelationships.workspaceId, workspaceId))
    .catch(() => [])
  const haveByKey = new Map<string, typeof existing[0]>()
  for (const r of existing) {
    haveByKey.set(`${r.sourceKind}:${r.sourceId}|${r.relationship}|${r.targetKind}:${r.targetId}`, r)
  }

  let inserted = 0, unchanged = 0, pruned = 0
  const now = Date.now()

  // Insert new edges (anything in `want` that's not in `have`)
  for (const [k, edge] of want) {
    if (haveByKey.has(k)) { unchanged++; continue }
    await db.insert(entityRelationships).values({
      id:           uuidv7(),
      workspaceId,
      sourceKind:   edge.sourceKind,
      sourceId:     edge.sourceId,
      targetKind:   edge.targetKind,
      targetId:     edge.targetId,
      relationship: edge.relationship,
      evidence:     edge.evidence,
      confidence:   edge.confidence ?? 1.0,
      createdAt:    now,
      updatedAt:    now,
    }).catch((e: Error) => { console.error('[world-graph]', e.message); return null })
    inserted++
  }

  // Prune stale edges (in `have` but no longer in `want`)
  for (const [k, row] of haveByKey) {
    if (want.has(k)) continue
    await db.delete(entityRelationships)
      .where(eq(entityRelationships.id, row.id))
      .catch((e: Error) => { console.error('[world-graph]', e.message); return null })
    pruned++
  }

  await db.insert(events).values({
    id: uuidv7(), type: 'world_graph.populated', workspaceId,
    payload: { inserted, unchanged, pruned, total: want.size },
    traceId: uuidv7(), correlationId: uuidv7(), causationId: null,
    source: 'api/world-graph', version: 1, createdAt: now,
  }).catch((e: Error) => { console.error('[world-graph]', e.message); return null })

  return { inserted, unchanged, pruned }
}

// ── Queries ───────────────────────────────────────────────────────────

export interface NeighborhoodNode {
  kind: string
  id:   string
}

export interface NeighborhoodEdge {
  sourceKind: string; sourceId: string
  targetKind: string; targetId: string
  relationship: string
  evidence:     Record<string, unknown>
  confidence:   number
}

/**
 * Return all 1-hop edges touching (kind, id), both incoming + outgoing.
 */
export async function neighbors(
  workspaceId: string, kind: string, id: string,
): Promise<{ node: NeighborhoodNode; edges: NeighborhoodEdge[] }> {
  const matcher = or(
    and(eq(entityRelationships.sourceKind, kind), eq(entityRelationships.sourceId, id)),
    and(eq(entityRelationships.targetKind, kind), eq(entityRelationships.targetId, id)),
  )
  if (!matcher) return { node: { kind, id }, edges: [] }
  const rows = await db.select().from(entityRelationships)
    .where(and(eq(entityRelationships.workspaceId, workspaceId), matcher))
    .orderBy(desc(entityRelationships.updatedAt))
    .limit(200)
    .catch(() => [])
  return {
    node: { kind, id },
    edges: rows.map(r => ({
      sourceKind:   r.sourceKind,   sourceId: r.sourceId,
      targetKind:   r.targetKind,   targetId: r.targetId,
      relationship: r.relationship,
      evidence:     r.evidence as Record<string, unknown>,
      confidence:   r.confidence,
    })),
  }
}

/**
 * Breadth-first traverse out to `maxHops` from a seed entity.
 * Bounded fan-out per node to prevent hairball explosions.
 */
export async function subgraph(
  workspaceId: string, kind: string, id: string,
  opts: { maxHops?: number; maxPerNode?: number } = {},
): Promise<{ nodes: NeighborhoodNode[]; edges: NeighborhoodEdge[] }> {
  const maxHops    = Math.min(opts.maxHops    ?? 2, 4)
  const maxPerNode = Math.min(opts.maxPerNode ?? 50, 200)

  const seen   = new Set<string>([`${kind}:${id}`])
  const nodes: NeighborhoodNode[] = [{ kind, id }]
  const edges: NeighborhoodEdge[] = []

  let frontier: NeighborhoodNode[] = [{ kind, id }]
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: NeighborhoodNode[] = []
    for (const n of frontier) {
      const r = await neighbors(workspaceId, n.kind, n.id)
      let countPushed = 0
      for (const e of r.edges) {
        if (countPushed >= maxPerNode) break
        edges.push(e)
        const otherKind = e.sourceKind === n.kind && e.sourceId === n.id ? e.targetKind : e.sourceKind
        const otherId   = e.sourceKind === n.kind && e.sourceId === n.id ? e.targetId   : e.sourceId
        const key = `${otherKind}:${otherId}`
        if (!seen.has(key)) {
          seen.add(key)
          const node = { kind: otherKind, id: otherId }
          nodes.push(node)
          next.push(node)
          countPushed++
        }
      }
    }
    frontier = next
  }
  return { nodes, edges }
}

// Suppress unused-import lint (kept for downstream queries)
void inArray; void isNotNull; void businesses
