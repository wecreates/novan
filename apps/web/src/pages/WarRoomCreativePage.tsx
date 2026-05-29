/**
 * WarRoomCreativePage — dedicated war-room page for creative system
 * metrics at /war-room/creative.
 *
 * Builds on the existing /api/v1/studio/creative/metrics endpoint plus
 * the graph endpoint. Surfaces:
 *   - KPI strip (totals + averages + reject/flag rates)
 *   - Top styles by volume + avg quality
 *   - Provider health (success rate, latency, avg quality per provider)
 *   - Recent flags rollup
 *   - Quality heatmap (sourced from /creative/graph)
 *
 * Calm, tabular, glanceable — matches the voice-analytics page in tone.
 */
import React from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, BarChart3, Sparkles, ShieldAlert } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Metrics {
  totalGenerations: number
  avgQuality:       number | null
  avgSlopRisk:      number | null
  avgOriginality:   number | null
  rejectRate:       number
  flagRate:         number
  topStyles:        Array<{ style: string; count: number; avgQuality: number }>
  topBrandCategories: Array<{ category: string; count: number }>
  providerHealth:   Array<{ provider: string; samples: number; successRate: number; avgLatency: number; avgQuality: number }>
  recentFlags:      string[]
}
interface GraphHeatmap { bins: number[]; buckets: { low: number; medium: number; high: number }; total: number }
interface GraphResp { heatmap: GraphHeatmap; nodes: { id: string }[] }

export default function WarRoomCreativePage() {
  const { workspaceId } = useWorkspace()

  const metricsQ = useQuery<{ data: Metrics }>({
    queryKey: ['war-room-creative', 'metrics', workspaceId],
    queryFn:  () => api.get(`/api/v1/studio/creative/metrics?workspace_id=${workspaceId}&window_days=30`),
    refetchInterval: 30_000,
    enabled:  !!workspaceId,
  })
  const graphQ = useQuery<{ data: GraphResp }>({
    queryKey: ['war-room-creative', 'graph', workspaceId],
    queryFn:  () => api.get(`/api/v1/studio/creative/graph?workspace_id=${workspaceId}&window_days=30&limit=500`),
    refetchInterval: 60_000,
    enabled:  !!workspaceId,
  })

  const m = metricsQ.data?.data ?? null
  const heatmap = graphQ.data?.data.heatmap

  return (
    <div className="min-h-screen bg-[#0b0d10] text-primary">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-border/40">
        <Link to="/war-room" className="btn btn-ghost text-2xs"><ArrowLeft className="w-3 h-3 mr-1" />Back</Link>
        <h1 className="text-base font-semibold flex items-center gap-2"><BarChart3 className="w-4 h-4 text-cyan-300" />Creative — war room</h1>
        <span className="text-2xs text-muted ml-auto">last 30 days</span>
        <Link to="/creative/brain" className="btn btn-ghost text-2xs"><Sparkles className="w-3 h-3 mr-1" />Brain view</Link>
        <Link to="/creative" className="btn btn-ghost text-2xs">Workspace</Link>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">
        {/* KPI strip */}
        <section className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Kpi label="Generations"     value={String(m?.totalGenerations ?? 0)} />
          <Kpi label="Avg quality"     value={pct(m?.avgQuality)} />
          <Kpi label="Avg originality" value={pct(m?.avgOriginality)} />
          <Kpi label="Avg slop-risk"   value={pct(m?.avgSlopRisk)} {...((m?.avgSlopRisk ?? 0) > 0.4 ? { accent: 'rose' as const } : {})} />
          <Kpi label="Reject rate"     value={`${((m?.rejectRate ?? 0) * 100).toFixed(1)}%`} {...((m?.rejectRate ?? 0) > 0.1 ? { accent: 'rose' as const } : {})} />
          <Kpi label="Flag rate"       value={`${((m?.flagRate ?? 0) * 100).toFixed(1)}%`} />
        </section>

        {/* Quality heatmap */}
        {heatmap && heatmap.total > 0 && (
          <section className="drawer-edge p-4">
            <div className="label mb-2">Quality heatmap · 10 bins · {heatmap.total} scored</div>
            <div className="flex h-16 rounded overflow-hidden border border-border/40">
              {heatmap.bins.map((count, i) => {
                const pct = count / Math.max(...heatmap.bins, 1)
                const isHigh = i >= 7, isLow = i <= 3
                return (
                  <div key={i} className="flex-1 relative" title={`${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)} · ${count}`}>
                    <div className={`absolute bottom-0 left-0 right-0 ${isHigh ? 'bg-emerald-400/70' : isLow ? 'bg-rose-400/70' : 'bg-amber-400/70'}`} style={{ height: `${pct * 100}%` }} />
                  </div>
                )
              })}
            </div>
            <div className="flex justify-between mt-1 text-2xs text-muted">
              <span>0.0 · low quality</span><span>0.5</span><span>1.0 · top tier</span>
            </div>
          </section>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top styles */}
          <section>
            <div className="label mb-2">Top styles · last 30d</div>
            <div className="drawer-edge overflow-x-auto">
              <table className="w-full text-2xs">
                <thead className="text-muted">
                  <tr><th className="text-left p-2">style</th><th className="text-left p-2">count</th><th className="text-left p-2">avg quality</th></tr>
                </thead>
                <tbody>
                  {(m?.topStyles ?? []).length === 0 && <tr><td colSpan={3} className="p-3 text-center text-muted italic">No style usage yet.</td></tr>}
                  {(m?.topStyles ?? []).map(s => (
                    <tr key={s.style} className="border-t border-border">
                      <td className="p-2 font-mono">{s.style}</td>
                      <td className="p-2 text-muted">{s.count}</td>
                      <td className="p-2"><QualityBar value={s.avgQuality} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Provider health */}
          <section>
            <div className="label mb-2">Provider health</div>
            <div className="drawer-edge overflow-x-auto">
              <table className="w-full text-2xs">
                <thead className="text-muted">
                  <tr><th className="text-left p-2">provider</th><th className="text-left p-2">n</th><th className="text-left p-2">success</th><th className="text-left p-2">p50 latency</th><th className="text-left p-2">avg quality</th></tr>
                </thead>
                <tbody>
                  {(m?.providerHealth ?? []).length === 0 && <tr><td colSpan={5} className="p-3 text-center text-muted italic">No provider data yet.</td></tr>}
                  {(m?.providerHealth ?? []).map(p => (
                    <tr key={p.provider} className="border-t border-border">
                      <td className="p-2 font-mono">{p.provider}</td>
                      <td className="p-2 text-muted">{p.samples}</td>
                      <td className={`p-2 ${p.successRate < 0.8 ? 'text-rose-300' : 'text-emerald-300'}`}>{(p.successRate * 100).toFixed(0)}%</td>
                      <td className="p-2">{p.avgLatency}ms</td>
                      <td className="p-2"><QualityBar value={p.avgQuality} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Recent flags + brand categories */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <div className="label mb-2 flex items-center gap-2"><ShieldAlert className="w-3 h-3 text-amber-300" />Recent creative flags</div>
            <div className="drawer-edge p-3 max-h-[280px] overflow-y-auto">
              {(m?.recentFlags ?? []).length === 0 && <div className="text-2xs text-muted italic">No flags raised — clean run.</div>}
              <ul className="text-2xs space-y-1 font-mono">
                {(m?.recentFlags ?? []).map((f, i) => <li key={i} className="truncate">{f}</li>)}
              </ul>
            </div>
          </section>

          <section>
            <div className="label mb-2">Top brand categories</div>
            <div className="drawer-edge overflow-x-auto">
              <table className="w-full text-2xs">
                <thead className="text-muted"><tr><th className="text-left p-2">category</th><th className="text-left p-2">count</th></tr></thead>
                <tbody>
                  {(m?.topBrandCategories ?? []).length === 0 && <tr><td colSpan={2} className="p-3 text-center text-muted italic">No brand categories tagged.</td></tr>}
                  {(m?.topBrandCategories ?? []).map(b => (
                    <tr key={b.category} className="border-t border-border">
                      <td className="p-2 font-mono">{b.category}</td>
                      <td className="p-2 text-muted">{b.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: 'rose' }) {
  return (
    <div className="drawer-edge p-3">
      <div className="text-2xs text-muted">{label}</div>
      <div className={`text-lg font-semibold ${accent === 'rose' ? 'text-rose-300' : ''}`}>{value}</div>
    </div>
  )
}

function QualityBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value))
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 max-w-[80px] h-2 rounded bg-surface-hover overflow-hidden">
        <div className={`h-full ${pct >= 0.7 ? 'bg-emerald-400' : pct >= 0.4 ? 'bg-amber-400' : 'bg-rose-400'}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="font-mono">{(value * 100).toFixed(0)}</span>
    </div>
  )
}

function pct(n: number | null | undefined): string { return n == null ? '—' : `${(n * 100).toFixed(0)}%` }
