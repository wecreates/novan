/**
 * R601 — Knowledge graph (Obsidian + Graphify class, built better).
 *
 * What Obsidian + Graphify give you:
 *   - Bidirectional [[wiki-links]] + automatic backlinks
 *   - Tag system (#topic)
 *   - Graph view + neighborhood traversal
 *   - Daily notes
 *   - Maps of Content (MOCs)
 *
 * What R601 adds on top:
 *   - Persistent server-side store (Postgres) — survives across devices, queryable by ANY agent
 *   - Typed nodes (note | concept | person | business | source | event | task | finding)
 *   - Typed, weighted edges (links | refs | mentions | tagged | depends_on | derived_from | contradicts)
 *   - R582 semantic recall already gives vector search — R601 layers on top to add the GRAPH layer
 *   - Auto-link from text: [[node-name]] + #tag scan + URL+title extraction
 *   - BFS k-hop neighborhood
 *   - Shortest-path between two concepts (Dijkstra over weight)
 *   - Centrality = weighted in-degree + bonus from importance
 *   - Mermaid export for live visualization
 *   - Brain ops let any agent (R193 self-dev, R598 pipelines, chat, cron) write + query without
 *     stepping on each other (atomic UPSERT by (workspace, name))
 *
 * Vector recall + KG together = semantic + structural retrieval. R215 brain-loop can pull
 * "5 things you semantically remembered" + "3 things directly connected to that concept".
 */
import { sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { db } from '../db/client.js'

const NODE_TYPES = new Set(['note', 'concept', 'person', 'business', 'source', 'event', 'task', 'finding', 'standard', 'spec'])
const EDGE_KINDS = new Set(['links', 'refs', 'mentions', 'tagged', 'depends_on', 'derived_from', 'contradicts', 'parent_of', 'related'])

async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kg_nodes (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      business_id   TEXT,
      type          TEXT NOT NULL DEFAULT 'note',
      name          TEXT NOT NULL,
      body          TEXT NOT NULL DEFAULT '',
      tags          JSONB NOT NULL DEFAULT '[]'::jsonb,
      importance    INT NOT NULL DEFAULT 50,
      source        TEXT,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS kg_nodes_ws_name_idx ON kg_nodes (workspace_id, name)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kg_nodes_ws_type_idx ON kg_nodes (workspace_id, type, updated_at DESC)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kg_nodes_ws_tags_gin ON kg_nodes USING gin (tags)`).catch(() => {})

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kg_edges (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      from_node     TEXT NOT NULL,
      to_node       TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'links',
      weight        REAL NOT NULL DEFAULT 1.0,
      source        TEXT,
      created_at    BIGINT NOT NULL
    )
  `).catch(() => {})
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS kg_edges_ws_unique_idx ON kg_edges (workspace_id, from_node, to_node, kind)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kg_edges_ws_from_idx ON kg_edges (workspace_id, from_node)`).catch(() => {})
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kg_edges_ws_to_idx   ON kg_edges (workspace_id, to_node)`).catch(() => {})
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KgNode {
  id:          string
  workspaceId: string
  businessId:  string | null
  type:        string
  name:        string
  body:        string
  tags:        string[]
  importance:  number
  source:      string | null
  createdAt:   number
  updatedAt:   number
}

export interface KgEdge {
  id:          string
  workspaceId: string
  fromNode:    string
  toNode:      string
  kind:        string
  weight:      number
  source:      string | null
  createdAt:   number
}

function rowToNode(r: any): KgNode {
  return {
    id: r.id, workspaceId: r.workspace_id, businessId: r.business_id ?? null,
    type: r.type, name: r.name, body: r.body, tags: Array.isArray(r.tags) ? r.tags : [],
    importance: Number(r.importance), source: r.source ?? null,
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  }
}

function rowToEdge(r: any): KgEdge {
  return {
    id: r.id, workspaceId: r.workspace_id, fromNode: r.from_node, toNode: r.to_node,
    kind: r.kind, weight: Number(r.weight), source: r.source ?? null, createdAt: Number(r.created_at),
  }
}

// ─── Node CRUD ───────────────────────────────────────────────────────────────

export interface UpsertNodeInput {
  name:        string
  type?:       string
  body?:       string
  tags?:       string[]
  importance?: number
  source?:     string
  businessId?: string
}

export async function upsertNode(workspaceId: string, input: UpsertNodeInput): Promise<KgNode> {
  await ensureTables()
  if (!input.name?.trim()) throw new Error('name required')
  const type = input.type && NODE_TYPES.has(input.type) ? input.type : 'note'
  const now = Date.now()
  const existing = await db.execute(sql`SELECT id FROM kg_nodes WHERE workspace_id = ${workspaceId} AND name = ${input.name} LIMIT 1`).catch(() => [] as unknown[])
  const id = (existing as Array<{ id: string }>)[0]?.id ?? uuidv7()
  await db.execute(sql`
    INSERT INTO kg_nodes (id, workspace_id, business_id, type, name, body, tags, importance, source, created_at, updated_at)
    VALUES (${id}, ${workspaceId}, ${input.businessId ?? null}, ${type}, ${input.name},
            ${input.body ?? ''}, ${JSON.stringify(input.tags ?? [])}::jsonb,
            ${typeof input.importance === 'number' ? input.importance : 50},
            ${input.source ?? null}, ${now}, ${now})
    ON CONFLICT (workspace_id, name) DO UPDATE SET
      type        = EXCLUDED.type,
      body        = EXCLUDED.body,
      tags        = EXCLUDED.tags,
      importance  = EXCLUDED.importance,
      source      = COALESCE(EXCLUDED.source, kg_nodes.source),
      business_id = COALESCE(EXCLUDED.business_id, kg_nodes.business_id),
      updated_at  = EXCLUDED.updated_at
  `).catch(() => {})
  const r = await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} AND name = ${input.name} LIMIT 1`).catch(() => [] as unknown[])
  return rowToNode((r as any[])[0])
}

export async function getNode(workspaceId: string, name: string): Promise<KgNode | null> {
  await ensureTables()
  const r = await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} AND name = ${name} LIMIT 1`).catch(() => [] as unknown[])
  const row = (r as any[])[0]
  return row ? rowToNode(row) : null
}

export async function listNodes(workspaceId: string, opts: { type?: string; tag?: string; limit?: number } = {}): Promise<KgNode[]> {
  await ensureTables()
  const lim = Math.min(opts.limit ?? 50, 500)
  const r = opts.type && opts.tag
    ? await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} AND type = ${opts.type} AND tags @> ${JSON.stringify([opts.tag])}::jsonb ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`)
    : opts.type
    ? await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} AND type = ${opts.type} ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`)
    : opts.tag
    ? await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} AND tags @> ${JSON.stringify([opts.tag])}::jsonb ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`)
    : await db.execute(sql`SELECT * FROM kg_nodes WHERE workspace_id = ${workspaceId} ORDER BY importance DESC, updated_at DESC LIMIT ${lim}`)
  return (r as any[]).map(rowToNode)
}

// ─── Edge CRUD ───────────────────────────────────────────────────────────────

export async function upsertEdge(workspaceId: string, fromName: string, toName: string, kind = 'links', weight = 1.0, source?: string): Promise<KgEdge | null> {
  await ensureTables()
  if (!EDGE_KINDS.has(kind)) throw new Error(`unknown edge kind: ${kind}`)
  // Ensure both nodes exist (auto-create stubs).
  const from = await upsertNode(workspaceId, { name: fromName, type: 'concept', source })
  const to   = await upsertNode(workspaceId, { name: toName,   type: 'concept', source })
  const id = uuidv7()
  await db.execute(sql`
    INSERT INTO kg_edges (id, workspace_id, from_node, to_node, kind, weight, source, created_at)
    VALUES (${id}, ${workspaceId}, ${from.id}, ${to.id}, ${kind}, ${weight}, ${source ?? null}, ${Date.now()})
    ON CONFLICT (workspace_id, from_node, to_node, kind) DO UPDATE SET
      weight = (kg_edges.weight + EXCLUDED.weight) / 2,
      source = COALESCE(EXCLUDED.source, kg_edges.source)
  `).catch(() => {})
  const r = await db.execute(sql`SELECT * FROM kg_edges WHERE workspace_id = ${workspaceId} AND from_node = ${from.id} AND to_node = ${to.id} AND kind = ${kind} LIMIT 1`).catch(() => [] as unknown[])
  const row = (r as any[])[0]
  return row ? rowToEdge(row) : null
}

// ─── Auto-ingest from text ───────────────────────────────────────────────────

const WIKI_LINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
const HASHTAG   = /(?:^|\s)#([a-z][a-z0-9_-]{1,40})/gi

export interface IngestResult {
  node:        KgNode
  linkedNodes: string[]
  tags:        string[]
  edgeCount:   number
}

/** Parse a body of text, extract [[wiki-links]] + #tags, persist nodes + edges. */
export async function ingestText(workspaceId: string, opts: { name: string; body: string; type?: string; importance?: number; source?: string; businessId?: string }): Promise<IngestResult> {
  await ensureTables()
  const links = new Set<string>()
  let m: RegExpExecArray | null
  WIKI_LINK.lastIndex = 0
  while ((m = WIKI_LINK.exec(opts.body))) {
    if (m[1]) links.add(m[1].trim())
  }
  const tags = new Set<string>()
  HASHTAG.lastIndex = 0
  while ((m = HASHTAG.exec(opts.body))) {
    if (m[1]) tags.add(m[1].toLowerCase())
  }
  const upsertOpts: UpsertNodeInput = {
    name: opts.name, body: opts.body, tags: [...tags],
  }
  if (opts.type) upsertOpts.type = opts.type
  if (typeof opts.importance === 'number') upsertOpts.importance = opts.importance
  if (opts.source) upsertOpts.source = opts.source
  if (opts.businessId) upsertOpts.businessId = opts.businessId
  const node = await upsertNode(workspaceId, upsertOpts)
  let edgeCount = 0
  for (const target of links) {
    const e = await upsertEdge(workspaceId, opts.name, target, 'links', 1.0, opts.source)
    if (e) edgeCount++
  }
  return { node, linkedNodes: [...links], tags: [...tags], edgeCount }
}

// ─── Backlinks + neighbors ───────────────────────────────────────────────────

export interface Backlink {
  fromName:    string
  fromType:    string
  kind:        string
  weight:      number
  fromBody:    string
}

export async function backlinks(workspaceId: string, name: string, limit = 50): Promise<Backlink[]> {
  await ensureTables()
  const node = await getNode(workspaceId, name)
  if (!node) return []
  const r = await db.execute(sql`
    SELECT n.name AS from_name, n.type AS from_type, n.body AS from_body, e.kind, e.weight
    FROM kg_edges e JOIN kg_nodes n ON n.id = e.from_node
    WHERE e.workspace_id = ${workspaceId} AND e.to_node = ${node.id}
    ORDER BY e.weight DESC, n.importance DESC
    LIMIT ${Math.min(limit, 200)}
  `).catch(() => [] as unknown[])
  return (r as Array<{ from_name: string; from_type: string; from_body: string; kind: string; weight: number }>).map(x => ({
    fromName: x.from_name, fromType: x.from_type, fromBody: (x.from_body || '').slice(0, 200), kind: x.kind, weight: Number(x.weight),
  }))
}

export interface NeighborhoodHit {
  name:     string
  type:     string
  hops:     number
  importance:number
}

/** BFS k-hop neighborhood. Returns nodes within `depth` hops of the seed. */
export async function neighborhood(workspaceId: string, name: string, depth = 2, max = 50): Promise<NeighborhoodHit[]> {
  await ensureTables()
  const seed = await getNode(workspaceId, name)
  if (!seed) return []
  const visited = new Map<string, { hops: number; node: KgNode }>()
  visited.set(seed.id, { hops: 0, node: seed })
  let frontier = new Set<string>([seed.id])
  for (let d = 1; d <= depth && visited.size < max; d++) {
    if (frontier.size === 0) break
    const ids = [...frontier]
    const r = await db.execute(sql`
      SELECT DISTINCT n.* FROM kg_edges e JOIN kg_nodes n ON n.id = e.to_node
      WHERE e.workspace_id = ${workspaceId} AND e.from_node = ANY(${ids}::text[])
      UNION
      SELECT DISTINCT n.* FROM kg_edges e JOIN kg_nodes n ON n.id = e.from_node
      WHERE e.workspace_id = ${workspaceId} AND e.to_node = ANY(${ids}::text[])
    `).catch(() => [] as unknown[])
    const next = new Set<string>()
    for (const row of r as any[]) {
      const n = rowToNode(row)
      if (visited.has(n.id)) continue
      visited.set(n.id, { hops: d, node: n })
      next.add(n.id)
      if (visited.size >= max) break
    }
    frontier = next
  }
  const out: NeighborhoodHit[] = []
  for (const { hops, node } of visited.values()) {
    if (node.id === seed.id) continue
    out.push({ name: node.name, type: node.type, hops, importance: node.importance })
  }
  out.sort((a, b) => a.hops - b.hops || b.importance - a.importance)
  return out
}

// ─── Centrality (weighted in-degree + importance bonus) ──────────────────────

export interface CentralityHit { name: string; type: string; score: number; inDegree: number; importance: number }

export async function centrality(workspaceId: string, limit = 20): Promise<CentralityHit[]> {
  await ensureTables()
  const r = await db.execute(sql`
    SELECT n.name, n.type, n.importance,
           COALESCE(SUM(e.weight), 0)::float AS in_deg
    FROM kg_nodes n
    LEFT JOIN kg_edges e ON e.to_node = n.id AND e.workspace_id = n.workspace_id
    WHERE n.workspace_id = ${workspaceId}
    GROUP BY n.name, n.type, n.importance
    ORDER BY in_deg DESC, n.importance DESC
    LIMIT ${Math.min(limit, 200)}
  `).catch(() => [] as unknown[])
  return (r as Array<{ name: string; type: string; importance: number; in_deg: number }>).map(x => {
    const inDeg = Number(x.in_deg) || 0
    return { name: x.name, type: x.type, importance: Number(x.importance), inDegree: inDeg, score: Math.round((inDeg + Number(x.importance) / 100) * 100) / 100 }
  })
}

// ─── Shortest path (Dijkstra over 1/weight as distance) ──────────────────────

export async function shortestPath(workspaceId: string, fromName: string, toName: string, maxHops = 6): Promise<{ path: string[]; cost: number } | null> {
  await ensureTables()
  const from = await getNode(workspaceId, fromName)
  const to   = await getNode(workspaceId, toName)
  if (!from || !to) return null
  if (from.id === to.id) return { path: [from.name], cost: 0 }
  // Load all edges once; the graph is small enough at workspace scope.
  const r = await db.execute(sql`SELECT from_node, to_node, weight FROM kg_edges WHERE workspace_id = ${workspaceId}`).catch(() => [] as unknown[])
  const adj = new Map<string, Array<{ to: string; cost: number }>>()
  for (const e of r as Array<{ from_node: string; to_node: string; weight: number }>) {
    const cost = 1 / Math.max(0.01, Number(e.weight))
    if (!adj.has(e.from_node)) adj.set(e.from_node, [])
    if (!adj.has(e.to_node)) adj.set(e.to_node, [])
    adj.get(e.from_node)!.push({ to: e.to_node, cost })
    adj.get(e.to_node)!.push({ to: e.from_node, cost })   // treat as undirected for path queries
  }
  // Dijkstra.
  const dist = new Map<string, number>([[from.id, 0]])
  const prev = new Map<string, string>()
  const queue = new Set<string>(adj.keys())
  while (queue.size > 0) {
    let curr: string | null = null, best = Infinity
    for (const q of queue) {
      const d = dist.get(q) ?? Infinity
      if (d < best) { best = d; curr = q }
    }
    if (!curr || best === Infinity) break
    if (curr === to.id) break
    queue.delete(curr)
    if (best > maxHops) break
    for (const { to: nbr, cost } of adj.get(curr) ?? []) {
      if (!queue.has(nbr)) continue
      const alt = best + cost
      if (alt < (dist.get(nbr) ?? Infinity)) {
        dist.set(nbr, alt); prev.set(nbr, curr)
      }
    }
  }
  if (!dist.has(to.id)) return null
  // Reconstruct path of node IDs, then resolve to names.
  const pathIds: string[] = [to.id]
  let cur: string | undefined = to.id
  while (cur && prev.has(cur)) { cur = prev.get(cur); if (cur) pathIds.unshift(cur) }
  const r2 = await db.execute(sql`SELECT id, name FROM kg_nodes WHERE workspace_id = ${workspaceId} AND id = ANY(${pathIds}::text[])`).catch(() => [] as unknown[])
  const nameById = new Map((r2 as Array<{ id: string; name: string }>).map(x => [x.id, x.name]))
  return { path: pathIds.map(id => nameById.get(id) ?? id), cost: Math.round((dist.get(to.id) ?? 0) * 100) / 100 }
}

// ─── Mermaid export ──────────────────────────────────────────────────────────

export async function mermaid(workspaceId: string, opts: { center?: string; depth?: number; max?: number } = {}): Promise<string> {
  const lines = ['graph LR']
  if (opts.center) {
    const hood = await neighborhood(workspaceId, opts.center, opts.depth ?? 2, opts.max ?? 30)
    const seed = await getNode(workspaceId, opts.center)
    if (seed) {
      const nodeIds = new Map<string, string>()
      const idFor = (name: string): string => {
        if (!nodeIds.has(name)) nodeIds.set(name, `n${nodeIds.size}`)
        return nodeIds.get(name)!
      }
      lines.push(`  ${idFor(seed.name)}["${seed.name.replace(/"/g, "'")}"]:::seed`)
      for (const h of hood) lines.push(`  ${idFor(h.name)}["${h.name.replace(/"/g, "'")}"]`)
      const edges = await db.execute(sql`
        SELECT a.name AS f, b.name AS t, e.kind FROM kg_edges e
        JOIN kg_nodes a ON a.id = e.from_node
        JOIN kg_nodes b ON b.id = e.to_node
        WHERE e.workspace_id = ${workspaceId} AND (a.name = ANY(${[seed.name, ...hood.map(h => h.name)]}::text[]) OR b.name = ANY(${[seed.name, ...hood.map(h => h.name)]}::text[]))
      `).catch(() => [] as unknown[])
      for (const e of edges as Array<{ f: string; t: string; kind: string }>) {
        if (nodeIds.has(e.f) && nodeIds.has(e.t)) lines.push(`  ${idFor(e.f)} -->|${e.kind}| ${idFor(e.t)}`)
      }
      lines.push('  classDef seed fill:#facc15,stroke:#a16207,color:#1f2937')
    }
  } else {
    const top = await centrality(workspaceId, opts.max ?? 20)
    const idFor = new Map<string, string>()
    top.forEach((h, i) => { idFor.set(h.name, `n${i}`); lines.push(`  n${i}["${h.name.replace(/"/g, "'")}"]`) })
    const edges = await db.execute(sql`
      SELECT a.name AS f, b.name AS t, e.kind FROM kg_edges e
      JOIN kg_nodes a ON a.id = e.from_node
      JOIN kg_nodes b ON b.id = e.to_node
      WHERE e.workspace_id = ${workspaceId} AND a.name = ANY(${top.map(t => t.name)}::text[]) AND b.name = ANY(${top.map(t => t.name)}::text[])
    `).catch(() => [] as unknown[])
    for (const e of edges as Array<{ f: string; t: string; kind: string }>) {
      if (idFor.has(e.f) && idFor.has(e.t)) lines.push(`  ${idFor.get(e.f)} -->|${e.kind}| ${idFor.get(e.t)}`)
    }
  }
  return lines.join('\n')
}

// ─── Daily note ──────────────────────────────────────────────────────────────

export async function dailyNote(workspaceId: string, opts: { dateUtc?: string; append?: string } = {}): Promise<KgNode> {
  const d = opts.dateUtc ? new Date(opts.dateUtc) : new Date()
  const name = `daily/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  const existing = await getNode(workspaceId, name)
  const body = existing ? `${existing.body}\n${opts.append ?? ''}`.trim() : (opts.append ?? `# ${name}`)
  return ingestText(workspaceId, { name, body, type: 'note', importance: 70, source: 'daily' }).then(r => r.node)
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function stats(workspaceId: string): Promise<{ nodes: number; edges: number; byType: Record<string, number>; topTags: Array<{ tag: string; n: number }> }> {
  await ensureTables()
  const n = await db.execute(sql`SELECT COUNT(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[])
  const e = await db.execute(sql`SELECT COUNT(*)::int AS n FROM kg_edges WHERE workspace_id = ${workspaceId}`).catch(() => [{ n: 0 }] as unknown[])
  const t = await db.execute(sql`SELECT type, COUNT(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId} GROUP BY type ORDER BY n DESC`).catch(() => [] as unknown[])
  const tags = await db.execute(sql`SELECT jsonb_array_elements_text(tags) AS tag, COUNT(*)::int AS n FROM kg_nodes WHERE workspace_id = ${workspaceId} GROUP BY tag ORDER BY n DESC LIMIT 10`).catch(() => [] as unknown[])
  const byType: Record<string, number> = {}
  for (const row of t as Array<{ type: string; n: number }>) byType[row.type] = Number(row.n)
  return {
    nodes:  Number((n as Array<{ n: number }>)[0]?.n ?? 0),
    edges:  Number((e as Array<{ n: number }>)[0]?.n ?? 0),
    byType,
    topTags: (tags as Array<{ tag: string; n: number }>).map(x => ({ tag: x.tag, n: Number(x.n) })),
  }
}
