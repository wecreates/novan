/**
 * CreativeBrainPage — focused creative graph view at /creative/brain.
 *
 * Renders the data from /api/v1/studio/creative/graph as three composed
 * visualizations:
 *   1. Style cluster cluster bubbles (size = volume, color = quality)
 *   2. Remix tree — each node is a generation thumbnail; edges between
 *      a generation and its remix source. SVG so it stays light.
 *   3. Quality heatmap strip (10 bins, 0 → 1)
 *
 * Pure SVG + CSS — no three.js. Matches the workspace's calm visual
 * language; it's an information surface, not an attention grab.
 */
import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, BarChart3, Sparkles } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface GraphNode {
  id: string; prompt: string; thumbUrl: string | null
  provider: string; stylePreset: string | null; brandCategory: string | null
  qualityScore: number | null; slopRiskScore: number | null; originalityScore: number | null
  batchId: string | null; sourceImageRef: string | null
  createdAt: number
}
interface GraphEdge   { from: string; to: string; kind: 'remix' | 'batch' }
interface GraphCluster { key: string; count: number; avgQuality: number; avgSlopRisk: number; sampleNodeId: string | null }
interface GraphHeatmap { bins: number[]; buckets: { low: number; medium: number; high: number }; total: number }
interface CreativeGraph {
  nodes: GraphNode[]; edges: GraphEdge[]; clusters: GraphCluster[]; heatmap: GraphHeatmap
  best: GraphNode | null; windowMs: number
}

export default function CreativeBrainPage() {
  const { workspaceId } = useWorkspace()
  const [focus, setFocus] = useState<string | null>(null)   // selected cluster key

  const graphQ = useQuery<{ data: CreativeGraph }>({
    queryKey: ['creative-brain', workspaceId],
    queryFn:  () => api.get(`/api/v1/studio/creative/graph?workspace_id=${workspaceId}&window_days=30&limit=200`),
    refetchInterval: 30_000,
    enabled:  !!workspaceId,
  })

  const graph = graphQ.data?.data ?? null
  const filteredNodes = useMemo(() => {
    if (!graph) return [] as GraphNode[]
    if (!focus) return graph.nodes
    return graph.nodes.filter(n => (n.stylePreset ?? 'uncategorized') === focus)
  }, [graph, focus])
  const filteredEdges = useMemo(() => {
    if (!graph) return [] as GraphEdge[]
    const ids = new Set(filteredNodes.map(n => n.id))
    return graph.edges.filter(e => ids.has(e.from) && ids.has(e.to))
  }, [graph, filteredNodes])

  return (
    <div className="min-h-screen bg-[#0b0d10] text-primary">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-border/40">
        <Link to="/creative" className="btn btn-ghost text-2xs"><ArrowLeft className="w-3 h-3 mr-1" />Back</Link>
        <h1 className="text-base font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4 text-cyan-300" />Creative Brain</h1>
        <span className="text-2xs text-muted ml-auto">last 30 days · {graph?.nodes.length ?? 0} generations</span>
        <Link to="/war-room/creative" className="btn btn-ghost text-2xs"><BarChart3 className="w-3 h-3 mr-1" />War room</Link>
      </header>

      {!graph || graph.nodes.length === 0 ? (
        <div className="flex items-center justify-center h-[60vh] text-muted text-sm italic">
          No generations in the last 30 days. Start in the <Link to="/creative" className="underline ml-1">Creative Workspace</Link>.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 p-6">
          {/* Left: cluster nav + best + heatmap */}
          <aside className="space-y-5">
            <div>
              <div className="label mb-2">Style clusters</div>
              <ul className="space-y-1">
                <li>
                  <button onClick={() => setFocus(null)} className={`w-full text-left px-2 py-1.5 rounded text-2xs ${focus === null ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-surface-hover'}`}>
                    <span className="flex items-center justify-between">
                      <span>all clusters</span>
                      <span className="text-muted font-mono">{graph.nodes.length}</span>
                    </span>
                  </button>
                </li>
                {graph.clusters.map(c => (
                  <li key={c.key}>
                    <button onClick={() => setFocus(c.key === focus ? null : c.key)} className={`w-full text-left px-2 py-1.5 rounded text-2xs ${focus === c.key ? 'bg-cyan-500/15 text-cyan-200' : 'hover:bg-surface-hover'}`}>
                      <span className="flex items-center justify-between">
                        <span className="truncate">{c.key}</span>
                        <span className="text-muted font-mono">{c.count} · Q{(c.avgQuality * 100).toFixed(0)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {graph.best && (
              <div>
                <div className="label mb-2">Best so far</div>
                <div className="drawer-edge overflow-hidden">
                  {graph.best.thumbUrl && <img src={graph.best.thumbUrl} alt="best" className="w-full aspect-square object-cover" />}
                  <div className="p-2 text-2xs">
                    <div className="text-muted">Q · {(typeof graph.best.qualityScore === 'number' ? graph.best.qualityScore * 100 : 0).toFixed(0)} · {graph.best.stylePreset ?? 'uncategorized'}</div>
                    <div className="truncate mt-1">{graph.best.prompt}</div>
                  </div>
                </div>
              </div>
            )}

            <div>
              <div className="label mb-2">Quality heatmap</div>
              <div className="flex h-10 rounded overflow-hidden border border-border/40">
                {graph.heatmap.bins.map((count, i) => {
                  const pct = graph.heatmap.total === 0 ? 0 : count / Math.max(...graph.heatmap.bins, 1)
                  const isHigh = i >= 7
                  const isLow  = i <= 3
                  return (
                    <div key={i} className="flex-1 relative" title={`${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)} · ${count}`}>
                      <div className={`absolute bottom-0 left-0 right-0 ${isHigh ? 'bg-emerald-400/70' : isLow ? 'bg-rose-400/70' : 'bg-amber-400/70'}`} style={{ height: `${pct * 100}%` }} />
                    </div>
                  )
                })}
              </div>
              <div className="grid grid-cols-3 gap-2 mt-2 text-2xs text-muted">
                <span>low · {graph.heatmap.buckets.low}</span>
                <span>med · {graph.heatmap.buckets.medium}</span>
                <span className="text-emerald-300">high · {graph.heatmap.buckets.high}</span>
              </div>
            </div>
          </aside>

          {/* Right: cluster bubbles + remix tree */}
          <main className="space-y-6">
            <section className="drawer-edge p-4">
              <div className="label mb-3">Style clusters · size = volume · color = quality</div>
              <ClusterBubbles clusters={graph.clusters} onFocus={setFocus} active={focus} />
            </section>

            <section className="drawer-edge p-4">
              <div className="label mb-3">
                Remix + batch lineage{focus ? ` · ${focus}` : ''}
                <span className="text-muted font-normal ml-2">({filteredEdges.length} links)</span>
              </div>
              {filteredEdges.length === 0 ? (
                <div className="text-2xs text-muted italic py-6">No remix or batch lineage in this view.</div>
              ) : (
                <RemixTree nodes={filteredNodes} edges={filteredEdges} />
              )}
            </section>
          </main>
        </div>
      )}
    </div>
  )
}

function ClusterBubbles({ clusters, onFocus, active }: { clusters: GraphCluster[]; onFocus: (k: string) => void; active: string | null }) {
  const maxCount = Math.max(...clusters.map(c => c.count), 1)
  return (
    <div className="flex flex-wrap gap-3 items-center">
      {clusters.length === 0 && <div className="text-2xs text-muted italic">No clusters yet.</div>}
      {clusters.map(c => {
        const size = 36 + (c.count / maxCount) * 64        // 36..100 px
        const isActive = active === c.key
        const tint = c.avgQuality > 0.7 ? 'bg-emerald-500/30 border-emerald-400/50'
                  : c.avgQuality > 0.4 ? 'bg-amber-500/30 border-amber-400/50'
                  : 'bg-rose-500/30 border-rose-400/50'
        return (
          <button
            key={c.key}
            onClick={() => onFocus(c.key === active ? '' : c.key)}
            title={`${c.key} · ${c.count} gens · avg quality ${(c.avgQuality * 100).toFixed(0)} · slop ${(c.avgSlopRisk * 100).toFixed(0)}`}
            className={`rounded-full border ${tint} ${isActive ? 'ring-2 ring-cyan-400/60' : ''} flex items-center justify-center text-2xs font-mono transition-all hover:scale-105`}
            style={{ width: `${size}px`, height: `${size}px` }}>
            <span className="truncate px-1">{c.key.slice(0, 8)}</span>
          </button>
        )
      })}
    </div>
  )
}

function RemixTree({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  // Layout: group by root (a node with no incoming edge in `edges`).
  // Each root + its descendants is a horizontal row.
  const incoming = new Map<string, GraphEdge>()
  for (const e of edges) incoming.set(e.to, e)
  const roots = nodes.filter(n => !incoming.has(n.id) && edges.some(e => e.from === n.id))

  // Show up to 6 trees so the page stays readable
  const treesToShow = roots.slice(0, 6)
  if (treesToShow.length === 0) return null

  return (
    <div className="space-y-4">
      {treesToShow.map(root => {
        const children = edges.filter(e => e.from === root.id).slice(0, 8)
        const childNodes = children.map(e => nodes.find(n => n.id === e.to)).filter((n): n is GraphNode => !!n)
        return (
          <div key={root.id} className="flex items-center gap-3">
            <Thumb node={root} large />
            {childNodes.length > 0 && (
              <>
                <span className="text-muted text-2xs">→</span>
                <div className="flex gap-2 overflow-x-auto">
                  {childNodes.map(c => <Thumb key={c.id} node={c} />)}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

function Thumb({ node, large }: { node: GraphNode; large?: boolean }) {
  const dim = large ? 'w-20 h-20' : 'w-14 h-14'
  const q = typeof node.qualityScore === 'number' ? Math.round(node.qualityScore * 100) : null
  return (
    <div className={`relative ${dim} flex-shrink-0 rounded overflow-hidden border border-border/40`} title={node.prompt}>
      {node.thumbUrl ? (
        <img src={node.thumbUrl} alt={node.prompt.slice(0, 50)} className="w-full h-full object-cover" loading="lazy" />
      ) : (
        <div className="w-full h-full bg-surface-hover" />
      )}
      {q !== null && (
        <span className={`absolute bottom-0 left-0 right-0 text-[9px] font-mono px-1 text-center ${q > 70 ? 'bg-emerald-500/60 text-white' : q > 40 ? 'bg-amber-500/60 text-white' : 'bg-rose-500/60 text-white'}`}>{q}</span>
      )}
    </div>
  )
}
