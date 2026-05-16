/**
 * EvolutionPage — Strategic War Room self-improvement view.
 *
 * Shows:
 * - Optimization tracking metrics (provider efficiency, patch success, rollback freq, etc.)
 * - Evidence-backed recommendations ranked by impact/risk
 * - Roadmap grouped into immediate / near-term / backlog
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  TrendingUp, Sparkles, Map, Zap, RefreshCcw,
  CheckCircle2, XCircle, Shield, ChevronDown, ChevronUp,
  Activity, DollarSign, AlertTriangle, BarChart3, Layers,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API = (p: string) => `/api/v1/improvement${p}`

async function fetchMetrics(ws: string)        { return (await (await fetch(`${API('/metrics')}?workspace_id=${ws}`)).json()).data as Metrics }
async function fetchRecs(ws: string, status?: string) {
  const q = new URLSearchParams({ workspace_id: ws }); if (status) q.set('status', status)
  return (await (await fetch(`${API('/recommendations')}?${q}`)).json()).data as Rec[]
}
async function fetchRoadmap(ws: string)        { return (await (await fetch(`${API('/roadmap')}?workspace_id=${ws}`)).json()).data as Roadmap }
async function postScan(ws: string)            { return (await (await fetch(API('/scan'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) })).json()).data }
async function postGenerate(ws: string)        { return (await (await fetch(API('/roadmap/generate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace_id: ws }) })).json()).data }
async function postApply(id: string, approval: boolean) {
  const r = await fetch(API(`/recommendations/${id}/apply`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'ops-user', approval_granted: approval }) })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}
async function postDismiss(id: string, reason: string) {
  const r = await fetch(API(`/recommendations/${id}/dismiss`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'ops-user', reason }) })
  if (!r.ok) throw new Error((await r.json()).error)
  return r.json()
}

interface Metrics {
  providerEfficiency:   number
  patchSuccessRate:     number
  rollbackFrequency:    number
  recoverySuccessRate:  number
  avgSandboxLatencyMs:  number
  queuePressure:        number
  recentBuildSuccessRate: number
}

interface Rec {
  id: string; category: string; subject: string
  title: string; description: string
  impact: number; risk: number; priorityScore: number
  evidenceRefs: Array<{ table: string; id: string }>
  status: string; requiresApproval: boolean
  recommendedAgent: string | null
  detectedAt: number
}

interface RoadmapEntry {
  id: string; title: string; category: string; phase: string
  impact: number; risk: number; priorityScore: number
  requiresApproval: boolean; recommendedAgent: string | null
}

interface Roadmap {
  immediate: RoadmapEntry[]; nearTerm: RoadmapEntry[]; backlog: RoadmapEntry[]
}

const CATEGORY_COLORS: Record<string, string> = {
  reliability:   'bg-red-500/20 text-red-400 border border-red-500/30',
  performance:   'bg-purple-500/20 text-purple-400 border border-purple-500/30',
  cost:          'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  ux:            'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  tests:         'bg-green-500/20 text-green-400 border border-green-500/30',
  observability: 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30',
  infra:         'bg-orange-500/20 text-orange-400 border border-orange-500/30',
}

const PHASE_COLORS: Record<string, string> = {
  immediate: 'bg-red-500/20 text-red-400',
  near_term: 'bg-yellow-500/20 text-yellow-400',
  backlog:   'bg-gray-500/20 text-gray-400',
}

function pct(n: number): string { return `${(n * 100).toFixed(0)}%` }
function ms(n: number): string  { return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s` }

function MetricCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
      </div>
      <p className={`text-2xl font-semibold mt-1 ${color}`}>{value}</p>
    </div>
  )
}

function RecCard({ r }: { r: Rec }) {
  const [open, setOpen] = useState(false)
  const [dismissNote, setDismissNote] = useState('')
  const [showDismiss, setShowDismiss] = useState(false)
  const qc = useQueryClient()

  const applyMut = useMutation({
    mutationFn: (approval: boolean) => postApply(r.id, approval),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['imp-recs'] }),
  })
  const dismissMut = useMutation({
    mutationFn: (reason: string) => postDismiss(r.id, reason),
    onSuccess:  () => { setShowDismiss(false); setDismissNote(''); qc.invalidateQueries({ queryKey: ['imp-recs'] }) },
  })

  const active = r.status === 'open' || r.status === 'in_roadmap'

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]">
      <div className="px-4 py-3 flex items-start gap-3">
        <div className="text-right shrink-0 min-w-[50px]">
          <p className={`text-lg font-semibold ${r.priorityScore >= 60 ? 'text-red-400' : r.priorityScore >= 30 ? 'text-yellow-400' : 'text-[var(--text-muted)]'}`}>
            {r.priorityScore}
          </p>
          <p className="text-xs text-[var(--text-muted)]">priority</p>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-[var(--text-primary)]">{r.title}</p>
            {r.requiresApproval && <span title="Requires approval"><Shield className="w-3.5 h-3.5 text-yellow-400" /></span>}
            <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_COLORS[r.category] ?? ''}`}>{r.category}</span>
          </div>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Impact {r.impact}/100 · Risk {r.risk}/100 · Evidence: {r.evidenceRefs.length} row(s)
            {r.recommendedAgent && <> · agent <span className="font-mono">{r.recommendedAgent}</span></>}
          </p>
        </div>
        <button onClick={() => setOpen((p) => !p)} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
          <p className="text-sm text-[var(--text-secondary)]">{r.description}</p>

          {r.evidenceRefs.length > 0 && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase mb-1">Evidence (real row IDs)</p>
              <div className="space-y-0.5">
                {r.evidenceRefs.slice(0, 5).map((e, i) => (
                  <p key={i} className="text-xs font-mono text-[var(--text-muted)]">
                    {e.table} → {e.id.slice(0, 16)}
                  </p>
                ))}
              </div>
            </div>
          )}

          {active && (
            <div>
              {!showDismiss ? (
                <div className="flex gap-2">
                  <button onClick={() => applyMut.mutate(r.requiresApproval ? true : false)} disabled={applyMut.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30 transition-colors disabled:opacity-50">
                    <CheckCircle2 className="w-3 h-3" />
                    {r.requiresApproval ? 'Apply (with approval)' : 'Apply'}
                  </button>
                  <button onClick={() => setShowDismiss(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/30 transition-colors">
                    <XCircle className="w-3 h-3" /> Dismiss
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <textarea value={dismissNote} onChange={(e) => setDismissNote(e.target.value)} rows={2}
                    placeholder="Dismissal reason (required)"
                    className="w-full text-xs rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] px-2 py-1.5 resize-none outline-none focus:border-blue-500/50" />
                  <div className="flex gap-2">
                    <button onClick={() => dismissMut.mutate(dismissNote)} disabled={dismissMut.isPending || !dismissNote.trim()}
                      className="px-3 py-1.5 rounded text-xs bg-gray-500/20 text-gray-400 hover:bg-gray-500/30 border border-gray-500/30 transition-colors disabled:opacity-50">
                      Confirm
                    </button>
                    <button onClick={() => { setShowDismiss(false); setDismissNote('') }}
                      className="px-3 py-1.5 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {r.status !== 'open' && r.status !== 'in_roadmap' && (
            <p className="text-xs text-[var(--text-muted)] italic">Status: {r.status}</p>
          )}
        </div>
      )}
    </div>
  )
}

function PhaseColumn({ title, entries, color }: { title: string; entries: RoadmapEntry[]; color: string }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-2">
        <h3 className={`text-sm font-medium ${color}`}>{title}</h3>
        <span className="text-xs text-[var(--text-muted)]">({entries.length})</span>
      </div>
      <div className="space-y-1.5">
        {entries.length === 0 && <p className="text-xs text-[var(--text-muted)] italic">No tasks in this phase</p>}
        {entries.map((t) => (
          <div key={t.id} className="rounded border border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-medium text-[var(--text-primary)]">{t.priorityScore}</span>
              <span className={`px-1.5 py-0.5 rounded text-xs ${CATEGORY_COLORS[t.category] ?? ''}`}>{t.category}</span>
              {t.requiresApproval && <Shield className="w-3 h-3 text-yellow-400" />}
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1 truncate">{t.title}</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">I{t.impact} / R{t.risk}{t.recommendedAgent && ` · ${t.recommendedAgent}`}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function EvolutionPage() {
  const { workspaceId } = useWorkspace()
  const [tab, setTab] = useState<'metrics' | 'recs' | 'roadmap'>('recs')
  const qc = useQueryClient()

  const { data: metrics } = useQuery({ queryKey: ['imp-metrics', workspaceId], queryFn: () => fetchMetrics(workspaceId), enabled: !!workspaceId, refetchInterval: 30_000 })
  const { data: recs = [] } = useQuery({ queryKey: ['imp-recs', workspaceId], queryFn: () => fetchRecs(workspaceId), enabled: !!workspaceId && tab === 'recs', refetchInterval: 30_000 })
  const { data: roadmap } = useQuery({ queryKey: ['imp-roadmap', workspaceId], queryFn: () => fetchRoadmap(workspaceId), enabled: !!workspaceId && tab === 'roadmap', refetchInterval: 30_000 })

  const scanMut = useMutation({
    mutationFn: () => postScan(workspaceId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['imp-recs'] }); qc.invalidateQueries({ queryKey: ['imp-metrics'] }) },
  })
  const genMut = useMutation({
    mutationFn: () => postGenerate(workspaceId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['imp-roadmap'] }); qc.invalidateQueries({ queryKey: ['imp-recs'] }) },
  })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-purple-400" /> Evolution
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Self-improvement runtime · evidence-based recommendations · autonomous roadmap
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => scanMut.mutate()} disabled={scanMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 border border-purple-500/30 transition-colors disabled:opacity-50">
              <Sparkles className="w-3 h-3" /> {scanMut.isPending ? 'Scanning…' : 'Scan'}
            </button>
            <button onClick={() => genMut.mutate()} disabled={genMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors disabled:opacity-50">
              <Zap className="w-3 h-3" /> {genMut.isPending ? 'Generating…' : 'Generate Roadmap'}
            </button>
            <button onClick={() => qc.invalidateQueries({ queryKey: ['imp-metrics'] })} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <RefreshCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {scanMut.data && (
          <div className="mt-3 text-xs text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded px-3 py-2">
            Scan: {scanMut.data.created} new, {scanMut.data.refreshed} refreshed
          </div>
        )}
        {genMut.data && (
          <div className="mt-3 text-xs text-blue-300 bg-blue-500/10 border border-blue-500/20 rounded px-3 py-2">
            Roadmap: {genMut.data.created} task(s) created
          </div>
        )}

        {metrics && tab === 'metrics' && (
          <div className="grid grid-cols-7 gap-2 mt-4">
            <MetricCard label="Provider OK" value={pct(metrics.providerEfficiency)} color={metrics.providerEfficiency > 0.9 ? 'text-green-400' : 'text-yellow-400'} icon={<Activity className="w-3 h-3" />} />
            <MetricCard label="Patch ✓" value={pct(metrics.patchSuccessRate)} color={metrics.patchSuccessRate > 0.8 ? 'text-green-400' : 'text-yellow-400'} icon={<CheckCircle2 className="w-3 h-3" />} />
            <MetricCard label="Rollback" value={pct(metrics.rollbackFrequency)} color={metrics.rollbackFrequency < 0.1 ? 'text-green-400' : 'text-red-400'} icon={<RefreshCcw className="w-3 h-3" />} />
            <MetricCard label="Recovery ✓" value={pct(metrics.recoverySuccessRate)} color={metrics.recoverySuccessRate > 0.7 ? 'text-green-400' : 'text-yellow-400'} icon={<Activity className="w-3 h-3" />} />
            <MetricCard label="Sandbox avg" value={ms(metrics.avgSandboxLatencyMs)} color={metrics.avgSandboxLatencyMs < 5000 ? 'text-green-400' : 'text-yellow-400'} icon={<BarChart3 className="w-3 h-3" />} />
            <MetricCard label="DLQ pressure" value={String(metrics.queuePressure)} color={metrics.queuePressure < 5 ? 'text-green-400' : 'text-red-400'} icon={<Layers className="w-3 h-3" />} />
            <MetricCard label="Build ✓ (7d)" value={pct(metrics.recentBuildSuccessRate)} color={metrics.recentBuildSuccessRate > 0.9 ? 'text-green-400' : 'text-red-400'} icon={<DollarSign className="w-3 h-3" />} />
          </div>
        )}

        <div className="flex gap-1 mt-3">
          {[
            { v: 'recs',    l: 'Recommendations', i: <Sparkles className="w-3 h-3" /> },
            { v: 'roadmap', l: 'Roadmap',         i: <Map className="w-3 h-3" /> },
            { v: 'metrics', l: 'Tracking',        i: <BarChart3 className="w-3 h-3" /> },
          ].map((t) => (
            <button key={t.v} onClick={() => setTab(t.v as typeof tab)}
              className={`px-3 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
                tab === t.v
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]'
              }`}>{t.i}{t.l}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {tab === 'recs' && (
          <div className="space-y-2 max-w-4xl">
            {recs.length === 0 && (
              <div className="text-center py-12 text-[var(--text-muted)]">
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No recommendations yet</p>
                <p className="text-xs mt-1 opacity-60">Click "Scan" to analyse runtime data and generate evidence-backed recommendations</p>
              </div>
            )}
            {recs.map((r) => <RecCard key={r.id} r={r} />)}
          </div>
        )}

        {tab === 'roadmap' && (
          <div className="max-w-7xl">
            {roadmap && (
              <div className="flex gap-4">
                <PhaseColumn title="Immediate"  entries={roadmap.immediate} color={PHASE_COLORS.immediate ?? ''} />
                <PhaseColumn title="Near-term"  entries={roadmap.nearTerm}  color={PHASE_COLORS.near_term ?? ''} />
                <PhaseColumn title="Backlog"    entries={roadmap.backlog}   color={PHASE_COLORS.backlog ?? ''} />
              </div>
            )}
            {!roadmap && (
              <div className="text-center py-12 text-[var(--text-muted)]">
                <Map className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No roadmap yet</p>
                <p className="text-xs mt-1 opacity-60">Click "Generate Roadmap" to group open recommendations into phases</p>
              </div>
            )}
          </div>
        )}

        {tab === 'metrics' && metrics && (
          <div className="max-w-3xl space-y-3">
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
              <p className="text-sm font-medium text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Runtime Optimization Tracking
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className="text-[var(--text-muted)]">Provider efficiency (24h):</span> <span className="font-mono ml-2">{pct(metrics.providerEfficiency)}</span></div>
                <div><span className="text-[var(--text-muted)]">Patch success rate:</span> <span className="font-mono ml-2">{pct(metrics.patchSuccessRate)}</span></div>
                <div><span className="text-[var(--text-muted)]">Rollback frequency:</span> <span className="font-mono ml-2">{pct(metrics.rollbackFrequency)}</span></div>
                <div><span className="text-[var(--text-muted)]">DLQ recovery rate:</span> <span className="font-mono ml-2">{pct(metrics.recoverySuccessRate)}</span></div>
                <div><span className="text-[var(--text-muted)]">Avg sandbox latency:</span> <span className="font-mono ml-2">{ms(metrics.avgSandboxLatencyMs)}</span></div>
                <div><span className="text-[var(--text-muted)]">Queue pressure (unreplayed):</span> <span className="font-mono ml-2">{metrics.queuePressure}</span></div>
                <div><span className="text-[var(--text-muted)]">Build success (7d):</span> <span className="font-mono ml-2">{pct(metrics.recentBuildSuccessRate)}</span></div>
              </div>
              <p className="text-xs text-[var(--text-muted)] mt-3 italic">
                All metrics computed from real Postgres rows. Empty values mean no data has been written yet.
              </p>
            </div>

            <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4">
              <p className="text-sm font-medium text-yellow-400 mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" /> Honesty note
              </p>
              <p className="text-xs text-[var(--text-secondary)]">
                Recommendations are based on persisted evidence only. Empty tables produce no recommendations —
                this is by design. Run more workloads through the system to surface real optimization opportunities.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
