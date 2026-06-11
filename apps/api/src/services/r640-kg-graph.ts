/**
 * R640 — Knowledge Graph visualization (E4).
 *
 * /ops/kg/graph — interactive force-directed graph of kg_nodes + kg_edges
 * using vis-network from a CDN (no npm dep). Click a node to see its
 * details. Filter by type. Search by name. Limited to top 500 nodes by
 * importance so the page stays responsive.
 *
 * Brain ops add a JSON export for headless use:
 *   kg.graph.export — { nodes:[…], edges:[…] } with cap + type filter
 */
import { sql } from 'drizzle-orm'
import { db } from '../db/client.js'

export interface GraphNode {
  id:         string
  name:       string
  type:       string
  importance: number
  tags:       string[]
}

export interface GraphEdge {
  id:        string
  source:    string
  target:    string
  relation:  string
  weight:    number
}

export interface KgGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  counts: { nodes: number; edges: number; byType: Record<string, number>; byRelation: Record<string, number> }
}

export interface ExportInput {
  maxNodes?: number          // default 200, cap 1000
  types?:    string[]
}

export async function exportGraph(workspaceId: string, input: ExportInput = {}): Promise<KgGraph> {
  const cap = Math.max(10, Math.min(1000, input.maxNodes ?? 200))

  const nodeRows = input.types && input.types.length > 0
    ? await db.execute(sql`
        SELECT id, name, type, importance, tags FROM kg_nodes
        WHERE workspace_id = ${workspaceId} AND type = ANY(${input.types})
        ORDER BY importance DESC NULLS LAST, created_at DESC LIMIT ${cap}
      `).catch(() => [] as unknown[])
    : await db.execute(sql`
        SELECT id, name, type, importance, tags FROM kg_nodes
        WHERE workspace_id = ${workspaceId}
        ORDER BY importance DESC NULLS LAST, created_at DESC LIMIT ${cap}
      `).catch(() => [] as unknown[])

  const nodes: GraphNode[] = (nodeRows as Array<Record<string, unknown>>).map(r => ({
    id:         String(r['id']),
    name:       String(r['name']),
    type:       String(r['type'] ?? 'note'),
    importance: Number(r['importance'] ?? 50),
    tags:       Array.isArray(r['tags']) ? r['tags'] as string[] : [],
  }))

  const nodeIds = new Set(nodes.map(n => n.id))
  const idsParam = nodes.map(n => n.id)
  const edgeRows = nodes.length === 0
    ? [] as unknown[]
    : await db.execute(sql`
        SELECT id, src_id, dst_id, relation, weight FROM kg_edges
        WHERE workspace_id = ${workspaceId}
          AND src_id = ANY(${idsParam}) AND dst_id = ANY(${idsParam})
        ORDER BY weight DESC NULLS LAST LIMIT ${cap * 5}
      `).catch(() => [] as unknown[])

  const edges: GraphEdge[] = (edgeRows as Array<Record<string, unknown>>)
    .filter(r => nodeIds.has(String(r['src_id'])) && nodeIds.has(String(r['dst_id'])))
    .map(r => ({
      id:       String(r['id']),
      source:   String(r['src_id']),
      target:   String(r['dst_id']),
      relation: String(r['relation'] ?? 'links'),
      weight:   Number(r['weight'] ?? 1),
    }))

  const byType: Record<string, number> = {}
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1
  const byRelation: Record<string, number> = {}
  for (const e of edges) byRelation[e.relation] = (byRelation[e.relation] ?? 0) + 1

  return { nodes, edges, counts: { nodes: nodes.length, edges: edges.length, byType, byRelation } }
}

const TYPE_COLOR: Record<string, string> = {
  note:        '#60a5fa',
  concept:     '#a78bfa',
  person:      '#f87171',
  business:    '#34d399',
  source:      '#fbbf24',
  event:       '#fb923c',
  task:        '#22d3ee',
  finding:     '#f472b6',
  standard:    '#94a3b8',
  spec:        '#9ca3af',
  research:    '#84cc16',
}

function esc(s: unknown): string { return String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) }

export async function renderKgGraphHtml(workspaceId: string): Promise<string> {
  const g = await exportGraph(workspaceId, { maxNodes: 250 })
  // Map to vis-network format
  const visNodes = g.nodes.map(n => ({
    id:    n.id,
    label: n.name.length > 26 ? n.name.slice(0, 24) + '…' : n.name,
    title: `${n.name} · ${n.type} · imp ${n.importance}`,
    color: TYPE_COLOR[n.type] ?? '#6b7280',
    value: Math.max(1, n.importance / 10),
    type:  n.type,
  }))
  const visEdges = g.edges.map(e => ({
    id:    e.id,
    from:  e.source,
    to:    e.target,
    label: e.relation === 'links' ? '' : e.relation,
    arrows: 'to',
    value: e.weight,
    color: { color: '#94a3b820' },
  }))

  const typeOpts = Object.entries(g.counts.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<option value="${esc(t)}">${esc(t)} (${n})</option>`).join('')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>KG graph · Novan</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;color:#1f2937}
  header{position:absolute;top:0;left:0;right:0;z-index:10;padding:10px 16px;background:#ffffffec;backdrop-filter:blur(8px);border-bottom:1px solid #e5e7eb;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header h1{margin:0;font-size:15px}
  header .meta{color:#6b7280;font-size:12px;margin-left:4px}
  header input,header select{font:13px sans-serif;padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff}
  #network{position:absolute;top:48px;bottom:0;left:0;right:0;background:#f9fafb}
  #details{position:absolute;top:60px;right:12px;width:280px;max-height:60vh;overflow:auto;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;box-shadow:0 4px 12px #00000010;display:none;font-size:13px}
  #details h2{margin:0 0 6px;font-size:14px}
  #details code{background:#f6f7f9;padding:1px 4px;border-radius:3px;font:11.5px ui-monospace,monospace}
  #details .tag{display:inline-block;padding:1px 6px;border-radius:3px;background:#eef2ff;color:#3730a3;font-size:11px;margin:1px 2px 1px 0}
  .legend{display:flex;gap:6px;flex-wrap:wrap;font-size:11px;color:#6b7280;margin-left:auto}
  .legend span{display:inline-flex;align-items:center;gap:3px}
  .swatch{display:inline-block;width:10px;height:10px;border-radius:50%}
</style>
</head>
<body>
<header>
  <h1>Knowledge Graph</h1>
  <span class="meta">workspace=${esc(workspaceId)} · ${g.counts.nodes} nodes · ${g.counts.edges} edges</span>
  <input id="q" type="search" placeholder="search…" />
  <select id="type"><option value="">all types</option>${typeOpts}</select>
  <span class="legend">${Object.entries(TYPE_COLOR).slice(0, 8).map(([t, c]) => `<span><span class="swatch" style="background:${c}"></span>${esc(t)}</span>`).join('')}</span>
</header>
<div id="network"></div>
<div id="details"></div>
<script src="https://unpkg.com/vis-network@9/standalone/umd/vis-network.min.js"></script>
<script>
(function(){
  const RAW_NODES = ${JSON.stringify(visNodes)};
  const RAW_EDGES = ${JSON.stringify(visEdges)};
  const nodes = new vis.DataSet(RAW_NODES);
  const edges = new vis.DataSet(RAW_EDGES);
  const container = document.getElementById('network');
  const network = new vis.Network(container, { nodes, edges }, {
    nodes: { shape: 'dot', scaling: { min: 6, max: 26 }, font: { size: 12, color: '#1f2937' } },
    edges: { smooth: { type: 'continuous' }, width: 0.6 },
    physics: { stabilization: { iterations: 120 }, barnesHut: { gravitationalConstant: -3000, springLength: 110 } },
    interaction: { hover: true, tooltipDelay: 200 },
  });

  const details = document.getElementById('details');
  network.on('selectNode', (ev) => {
    const id = ev.nodes[0]; if (!id) return;
    const n = RAW_NODES.find(x => x.id === id);
    if (!n) return;
    details.innerHTML = '<h2>' + n.label + '</h2>' +
      '<div><strong>type:</strong> <code>' + n.type + '</code></div>' +
      '<div><strong>id:</strong> <code>' + n.id + '</code></div>' +
      '<div style="margin-top:8px;color:#6b7280;font-size:12px">Use <code>kg.get_node</code> or <code>kg.neighborhood</code> brain op for full body + links.</div>';
    details.style.display = 'block';
  });
  network.on('deselectNode', () => details.style.display = 'none');
  network.on('click', (ev) => { if (ev.nodes.length === 0) details.style.display = 'none'; });

  // Search filter
  document.getElementById('q').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const t = document.getElementById('type').value;
    refilter(q, t);
  });
  document.getElementById('type').addEventListener('change', (e) => {
    const t = e.target.value;
    const q = document.getElementById('q').value.toLowerCase().trim();
    refilter(q, t);
  });
  function refilter(q, t) {
    const visible = new Set(RAW_NODES.filter(n => {
      if (t && n.type !== t) return false;
      if (q && !n.label.toLowerCase().includes(q) && !n.id.toLowerCase().includes(q)) return false;
      return true;
    }).map(n => n.id));
    nodes.update(RAW_NODES.map(n => ({ id: n.id, hidden: !visible.has(n.id) })));
    edges.update(RAW_EDGES.map(e => ({ id: e.id, hidden: !(visible.has(e.from) && visible.has(e.to)) })));
  }
})();
</script>
</body></html>`
}
