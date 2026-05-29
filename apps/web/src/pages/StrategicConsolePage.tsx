/**
 * StrategicConsolePage — operator-facing dashboard for the four
 * primitives shipped under migration 0034.
 *
 * Mounted at /strategic. Calm, glanceable, no decoration. Four panels:
 *   1. Cognitive load + recommended UI mode (#18)
 *   2. Behavioral anomalies (#21)
 *   3. Self-heal action log (#20)
 *   4. Why-chain inspector (#29) — paste a root event id, see the
 *      chronological reasoning chain leading up to it
 */
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, ShieldAlert, Wrench, GitBranch, ArrowLeft, Database, Rocket, Download, Trash2 } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface LoadSnapshot {
  loadScore: number; mode: 'calm' | 'normal' | 'deep' | 'overload'
  recommendation: string
  inputs: { eventVolume: number; alertVolume: number; pendingCount: number; interruptionRate: number; windowMs: number }
}
interface Anomaly {
  id: string; kind: string; severity: 'low' | 'medium' | 'high' | 'critical'
  score: number; subject: string | null; evidence: Record<string, unknown>
  firstSeenAt: number; lastSeenAt: number; occurrences: number
  ackedAt: number | null
}
interface HealAction {
  id: string; kind: string; targetKind: string; targetId: string
  reason: string; applied: boolean; createdAt: number
}
interface WhyStep {
  at: number; type: string; role: 'intent' | 'safety' | 'budget' | 'approval' | 'execution' | 'context'
  summary: string
}
interface WhyChain { rootEventId: string; anchorAt: number; steps: WhyStep[]; conclusion: string }

interface InspectRow { scope: string; rowCount: number; oldestAt: number | null; newestAt: number | null }
interface ReleaseHealth {
  score: number; verdict: 'healthy' | 'watching' | 'hold' | 'rollback'
  reasons: string[]; successRate: number; errorRatio: number; latencyRatio: number | null
  window: { from: number; to: number; deploysSeen: number }
}

export default function StrategicConsolePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [whyRoot, setWhyRoot] = useState('')

  const loadQ = useQuery<{ data: LoadSnapshot }>({
    queryKey: ['intel-ops', 'load', workspaceId],
    queryFn:  () => api.get(`/api/v1/intel-ops/load?workspace_id=${workspaceId}&window_min=30`),
    refetchInterval: 30_000,
    enabled:  !!workspaceId,
  })
  const anomaliesQ = useQuery<{ data: Anomaly[] }>({
    queryKey: ['intel-ops', 'anomalies', workspaceId],
    queryFn:  () => api.get(`/api/v1/intel-ops/anomalies?workspace_id=${workspaceId}&limit=20`),
    refetchInterval: 60_000,
    enabled:  !!workspaceId,
  })
  const healQ = useQuery<{ data: HealAction[] }>({
    queryKey: ['intel-ops', 'heal', workspaceId],
    queryFn:  () => api.get(`/api/v1/intel-ops/self-heal/actions?workspace_id=${workspaceId}&limit=30`),
    refetchInterval: 60_000,
    enabled:  !!workspaceId,
  })

  const whyQ = useQuery<{ data: WhyChain }>({
    queryKey: ['intel-ops', 'why', workspaceId, whyRoot],
    queryFn:  () => api.get(`/api/v1/intel-ops/why-chain?workspace_id=${workspaceId}&root_event_id=${encodeURIComponent(whyRoot)}`),
    enabled:  !!workspaceId && whyRoot.length > 0,
  })

  const inspectQ = useQuery<{ data: InspectRow[] }>({
    queryKey: ['intel-ops', 'inspect', workspaceId],
    queryFn:  () => api.get(`/api/v1/intel-ops/data/inspect?workspace_id=${workspaceId}`),
    enabled:  !!workspaceId,
  })
  const releaseQ = useQuery<{ data: ReleaseHealth }>({
    queryKey: ['intel-ops', 'release', workspaceId],
    queryFn:  () => api.get(`/api/v1/intel-ops/release/health?workspace_id=${workspaceId}&window_hours=24`),
    refetchInterval: 60_000,
    enabled:  !!workspaceId,
  })
  const exportMut = useMutation({
    mutationFn: async () => {
      const r = await api.post<{ data: { workspaceId: string; exportedAt: number; rowCounts: Record<string, number>; data: Record<string, unknown[]>; retention: Record<string, string> } }>('/api/v1/intel-ops/data/export', { workspace_id: workspaceId })
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `novan-export-${Date.now()}.json`; a.click()
      URL.revokeObjectURL(url)
      return r.data
    },
  })
  const triggerScan = useMutation({
    mutationFn: () => api.post('/api/v1/intel-ops/anomalies/scan', { workspace_id: workspaceId, window_min: 15 }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-ops', 'anomalies'] }),
  })
  const triggerHeal = useMutation({
    mutationFn: () => api.post('/api/v1/intel-ops/self-heal/scan', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-ops', 'heal'] }),
  })
  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/intel-ops/anomalies/${id}/ack`, { workspace_id: workspaceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel-ops', 'anomalies'] }),
  })

  const load = loadQ.data?.data
  const modeStyle: Record<string, string> = {
    calm:     'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    normal:   'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    deep:     'bg-amber-500/20 text-amber-300 border-amber-500/40',
    overload: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  }

  return (
    <div className="min-h-screen bg-[#0b0d10] text-primary">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-border/40">
        <Link to="/home" className="btn btn-ghost text-2xs"><ArrowLeft className="w-3 h-3 mr-1" />Back</Link>
        <h1 className="text-base font-semibold">Strategic console</h1>
        {load && (
          <span className={`text-2xs px-2 py-0.5 rounded-full border ${modeStyle[load.mode]}`}>
            {load.mode} · load {(load.loadScore * 100).toFixed(0)}
          </span>
        )}
        <span className="text-2xs text-muted ml-auto">primitives wired under migration 0034</span>
      </header>

      <main className="p-6 max-w-7xl mx-auto space-y-6">
        {/* Cognitive load */}
        <section className="drawer-edge p-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="label flex items-center gap-2"><Activity className="w-3 h-3" />Cognitive load</div>
            <span className="text-2xs text-muted">last 30 min</span>
          </div>
          {!load ? <div className="text-2xs text-muted italic">Loading…</div> : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-2xs">
                <Kpi label="Events"        value={String(load.inputs.eventVolume)} />
                <Kpi label="High alerts"   value={String(load.inputs.alertVolume)} accent={load.inputs.alertVolume > 3} />
                <Kpi label="Pending"       value={String(load.inputs.pendingCount)} accent={load.inputs.pendingCount > 4} />
                <Kpi label="Interrupt rate" value={`${(load.inputs.interruptionRate * 100).toFixed(0)}%`} />
                <Kpi label="Load score"    value={`${(load.loadScore * 100).toFixed(0)}`} accent={load.loadScore > 0.5} />
              </div>
              <div className="text-2xs text-muted mt-3 italic">{load.recommendation}</div>
            </>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Anomalies */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <div className="label flex items-center gap-2"><ShieldAlert className="w-3 h-3 text-rose-300" />Behavioral anomalies</div>
              <button onClick={() => triggerScan.mutate()} disabled={triggerScan.isPending} className="btn btn-ghost text-2xs">Re-scan</button>
            </div>
            <div className="drawer-edge max-h-[320px] overflow-y-auto">
              {(anomaliesQ.data?.data ?? []).length === 0 && <div className="text-2xs text-muted italic p-3">No anomalies detected.</div>}
              <table className="w-full text-2xs">
                <tbody>
                  {(anomaliesQ.data?.data ?? []).map(a => (
                    <tr key={a.id} className={`border-t border-border ${a.ackedAt ? 'opacity-50' : ''}`}>
                      <td className="p-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          a.severity === 'critical' ? 'bg-rose-500/30 text-rose-200' :
                          a.severity === 'high'     ? 'bg-amber-500/30 text-amber-200' :
                          'bg-surface-hover text-muted'
                        }`}>{a.severity}</span>
                      </td>
                      <td className="p-2 font-mono">{a.kind}</td>
                      <td className="p-2 text-muted">{a.subject ?? '—'}</td>
                      <td className="p-2">×{a.occurrences}</td>
                      <td className="p-2 text-right">
                        {!a.ackedAt && <button onClick={() => ack.mutate(a.id)} className="btn btn-ghost text-2xs">Ack</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Self-heal actions */}
          <section>
            <div className="flex items-baseline justify-between mb-2">
              <div className="label flex items-center gap-2"><Wrench className="w-3 h-3 text-cyan-300" />Self-heal actions</div>
              <button onClick={() => triggerHeal.mutate()} disabled={triggerHeal.isPending} className="btn btn-ghost text-2xs">Scan now</button>
            </div>
            <div className="drawer-edge max-h-[320px] overflow-y-auto">
              {(healQ.data?.data ?? []).length === 0 && <div className="text-2xs text-muted italic p-3">No recovery actions recorded.</div>}
              <table className="w-full text-2xs">
                <tbody>
                  {(healQ.data?.data ?? []).map(h => (
                    <tr key={h.id} className="border-t border-border">
                      <td className="p-2 text-muted">{new Date(h.createdAt).toLocaleTimeString()}</td>
                      <td className="p-2 font-mono">{h.kind}</td>
                      <td className="p-2 text-muted">{h.targetKind}</td>
                      <td className="p-2 truncate max-w-[200px]">{h.reason}</td>
                      <td className="p-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${h.applied ? 'bg-emerald-500/30 text-emerald-200' : 'bg-amber-500/30 text-amber-200'}`}>
                          {h.applied ? 'applied' : 'queued'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Release health (#31) */}
        <section className="drawer-edge p-4">
          <div className="label flex items-center gap-2 mb-3"><Rocket className="w-3 h-3 text-cyan-300" />Release health</div>
          {!releaseQ.data?.data ? <div className="text-2xs text-muted italic">No deploy events in window.</div> : (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-2xs">
              <Kpi label="Score"       value={`${(releaseQ.data.data.score * 100).toFixed(0)}`} accent={releaseQ.data.data.score < 0.5} />
              <Kpi label="Verdict"     value={releaseQ.data.data.verdict} accent={releaseQ.data.data.verdict === 'rollback' || releaseQ.data.data.verdict === 'hold'} />
              <Kpi label="Success"     value={`${(releaseQ.data.data.successRate * 100).toFixed(0)}%`} />
              <Kpi label="Error ratio" value={releaseQ.data.data.errorRatio.toFixed(2)} accent={releaseQ.data.data.errorRatio > 1.5} />
              <Kpi label="Deploys"     value={String(releaseQ.data.data.window.deploysSeen)} />
              <div className="col-span-2 md:col-span-5 text-muted italic">reasons · {releaseQ.data.data.reasons.join(' · ')}</div>
            </div>
          )}
        </section>

        {/* Data governance (#32) */}
        <section className="drawer-edge p-4">
          <div className="flex items-baseline justify-between mb-3">
            <div className="label flex items-center gap-2"><Database className="w-3 h-3" />Data governance</div>
            <div className="flex gap-2">
              <button onClick={() => exportMut.mutate()} disabled={exportMut.isPending} className="btn btn-ghost text-2xs"><Download className="w-3 h-3 mr-1" />Export all</button>
              <button
                onClick={async () => {
                  const reason = window.prompt('Reason for deletion (≥5 chars):')
                  if (!reason || reason.length < 5) return
                  if (!window.confirm('Permanently delete ALL voice + image data for this workspace? This cannot be undone.')) return
                  await api.post('/api/v1/intel-ops/data/delete', { workspace_id: workspaceId, confirm: true, reason }).catch(() => null)
                  qc.invalidateQueries({ queryKey: ['intel-ops', 'inspect'] })
                }}
                className="btn btn-ghost text-2xs text-rose-300"><Trash2 className="w-3 h-3 mr-1" />Erase workspace data</button>
            </div>
          </div>
          <table className="w-full text-2xs">
            <thead className="text-muted">
              <tr><th className="text-left p-2">scope</th><th className="text-left p-2">rows</th><th className="text-left p-2">oldest</th><th className="text-left p-2">newest</th></tr>
            </thead>
            <tbody>
              {(inspectQ.data?.data ?? []).map(r => (
                <tr key={r.scope} className="border-t border-border">
                  <td className="p-2 font-mono">{r.scope}</td>
                  <td className="p-2">{r.rowCount}</td>
                  <td className="p-2 text-muted">{r.oldestAt ? new Date(r.oldestAt).toLocaleDateString() : '—'}</td>
                  <td className="p-2 text-muted">{r.newestAt ? new Date(r.newestAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Why-chain inspector */}
        <section>
          <div className="label flex items-center gap-2 mb-2"><GitBranch className="w-3 h-3" />Why-chain inspector</div>
          <div className="drawer-edge p-4 space-y-3">
            <div className="flex gap-2">
              <input
                value={whyRoot}
                onChange={e => setWhyRoot(e.target.value)}
                placeholder="paste an event id (e.g. from /audit) and see the chain leading up to it"
                className="flex-1 px-3 py-2 text-xs bg-surface border border-border rounded outline-none font-mono"
              />
            </div>
            {whyQ.data?.data ? (
              <>
                <div className="text-2xs text-muted">Conclusion · <span className="text-primary">{whyQ.data.data.conclusion}</span></div>
                <ol className="space-y-1 text-2xs">
                  {whyQ.data.data.steps.map((s, i) => (
                    <li key={i} className="flex items-baseline gap-2">
                      <span className="text-muted w-16 font-mono">{new Date(s.at).toLocaleTimeString()}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] w-20 text-center ${
                        s.role === 'safety'    ? 'bg-rose-500/30 text-rose-200' :
                        s.role === 'budget'    ? 'bg-amber-500/30 text-amber-200' :
                        s.role === 'approval'  ? 'bg-cyan-500/30 text-cyan-200' :
                        s.role === 'execution' ? 'bg-emerald-500/30 text-emerald-200' :
                        s.role === 'intent'    ? 'bg-violet-500/30 text-violet-200' :
                        'bg-surface-hover text-muted'
                      }`}>{s.role}</span>
                      <span className="font-mono text-muted">{s.type}</span>
                      <span className="flex-1 truncate">{s.summary}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : whyRoot ? (
              <div className="text-2xs text-muted italic">Loading or not found.</div>
            ) : (
              <div className="text-2xs text-muted italic">Enter an event id to inspect the surrounding decision chain.</div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-2xs text-muted">{label}</div>
      <div className={`text-base font-semibold ${accent ? 'text-rose-300' : ''}`}>{value}</div>
    </div>
  )
}
