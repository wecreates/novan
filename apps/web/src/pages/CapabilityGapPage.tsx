/**
 * Capability Gap Builder — what Novan can do, what's missing, and the
 * build-vs-buy verdict for each. Plans are approval-gated.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Boxes, CheckCircle2, AlertOctagon, ChevronDown, ChevronRight,
  Hammer, Package, Layers, AlertTriangle, Sparkles,
} from 'lucide-react'
import { capabilityApi, type CapabilityStatusDTO, type BuildPlanDTO } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

function maturityColor(m: CapabilityStatusDTO['maturity']): string {
  switch (m) {
    case 'mature':     return 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
    case 'healthy':    return 'border-sky-500/40 bg-sky-500/5 text-sky-300'
    case 'basic':      return 'border-amber-500/40 bg-amber-500/5 text-amber-300'
    case 'scaffolded': return 'border-amber-500/40 bg-amber-500/10 text-amber-400'
    case 'missing':    return 'border-red-500/40 bg-red-500/5 text-red-300'
  }
}

function verdictBadge(v: CapabilityStatusDTO['buildVsBuy']['verdict']): { class: string; icon: JSX.Element; label: string } {
  switch (v) {
    case 'build':  return { class: 'bg-emerald-500/20 text-emerald-300', icon: <Hammer className="w-3 h-3" />,  label: 'BUILD' }
    case 'buy':    return { class: 'bg-sky-500/20 text-sky-300',          icon: <Package className="w-3 h-3" />, label: 'BUY' }
    case 'hybrid': return { class: 'bg-amber-500/20 text-amber-300',      icon: <Layers className="w-3 h-3" />,  label: 'HYBRID' }
    case 'defer':  return { class: 'bg-slate-500/20 text-slate-300',      icon: <AlertTriangle className="w-3 h-3" />, label: 'DEFER' }
  }
}

export default function CapabilityGapPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPlan, setSelectedPlan] = useState<BuildPlanDTO | null>(null)

  const status = useQuery({ queryKey: ['cap-status', workspaceId], queryFn: () => capabilityApi.status(workspaceId), refetchInterval: 5 * 60_000 })
  const dims   = useQuery({ queryKey: ['cap-dims',   workspaceId], queryFn: () => capabilityApi.dimensions(workspaceId), refetchInterval: 5 * 60_000 })

  const fetchPlan = useMutation({
    mutationFn: (id: string) => capabilityApi.plan(workspaceId, id),
    onSuccess: (r) => setSelectedPlan(r.data),
  })
  const persistPlan = useMutation({
    mutationFn: (id: string) => capabilityApi.persistPlan(workspaceId, id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cap-status', workspaceId] }) },
  })
  const planAll = useMutation({
    mutationFn: () => capabilityApi.planAllGaps(workspaceId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['cap-status', workspaceId] }) },
  })

  const all = status.data?.data ?? []
  const byDim = new Map<string, CapabilityStatusDTO[]>()
  for (const c of all) {
    const list = byDim.get(c.dimension) ?? []
    list.push(c); byDim.set(c.dimension, list)
  }

  const gapCount = all.filter(c => c.maturity === 'missing' || c.maturity === 'scaffolded').length

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Boxes className="w-6 h-6 text-sky-400" />
        <div className="flex-1">
          <h1 className="text-xl font-medium text-primary">Capability Gap Builder</h1>
          <p className="text-xs text-muted">
            {all.length} capabilities tracked · {gapCount} gaps · build-vs-buy verdicts based on transparent matrix
          </p>
        </div>
        <button
          onClick={() => planAll.mutate()}
          disabled={planAll.isPending}
          className="text-xs px-3 py-1.5 rounded border border-sky-500/40 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 disabled:opacity-50 flex items-center gap-1.5"
          title="For every gap with verdict=build|hybrid, generate a structured roadmap_tasks plan"
        >
          <Sparkles className="w-3 h-3" />
          {planAll.isPending ? 'Planning…' : planAll.data ? `Planned ${planAll.data.data.totalTasksCreated} tasks` : 'Plan all gaps'}
        </button>
      </div>

      {/* Dimension summary grid */}
      {dims.data && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {dims.data.data.map(d => {
            const gaps = d.missing + d.scaffolded
            return (
              <div key={d.dimension} className={`rounded-lg border px-3 py-2 ${gaps > 0 ? 'border-amber-500/40 bg-amber-500/5' : 'border-emerald-500/40 bg-emerald-500/5'}`}>
                <div className="text-[10px] uppercase tracking-wider text-muted">{d.dimension.replace(/_/g, ' ')}</div>
                <div className="text-lg font-mono">{d.total - gaps}/{d.total}</div>
                {gaps > 0 && (
                  <div className="text-[10px] text-amber-400 mt-0.5">{gaps} gap{gaps > 1 ? 's' : ''}</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Per-dimension capability lists */}
      {[...byDim.entries()].map(([dim, caps]) => (
        <div key={dim} className="rounded-lg border border-border bg-surface">
          <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
            <h3 className="text-sm font-medium text-primary uppercase tracking-wider">{dim.replace(/_/g, ' ')}</h3>
            <span className="text-xs text-muted">{caps.length}</span>
          </div>
          <ul className="divide-y divide-[var(--border)]">
            {caps.map(c => {
              const isExpanded = expanded.has(c.id)
              const v = verdictBadge(c.buildVsBuy.verdict)
              return (
                <li key={c.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <button onClick={() => {
                      const next = new Set(expanded)
                      if (next.has(c.id)) next.delete(c.id); else next.add(c.id)
                      setExpanded(next)
                    }} className="text-muted">
                      {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </button>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${maturityColor(c.maturity)}`}>{c.maturity}</span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${v.class} flex items-center gap-1`}>
                      {v.icon} {v.label}
                    </span>
                    <span className="flex-1 text-sm text-primary">{c.title}</span>
                    <span className="text-xs text-muted font-mono">{c.buildVsBuy.score >= 0 ? '+' : ''}{c.buildVsBuy.score.toFixed(2)}</span>
                    {(c.maturity === 'missing' || c.maturity === 'scaffolded') && c.buildVsBuy.verdict !== 'defer' && (
                      <button
                        onClick={() => fetchPlan.mutate(c.id)}
                        className="text-xs px-2 py-0.5 rounded border border-border hover:bg-elevated"
                      >
                        Plan
                      </button>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="mt-2 ml-7 text-xs space-y-1">
                      <div className="text-muted">{c.description}</div>
                      <div className="text-muted"><strong>Verdict:</strong> {c.buildVsBuy.rationale}</div>
                      <div className="text-muted"><strong>Notes:</strong> {c.buildVsBuy.notes}</div>
                      {c.evidence.length > 0 && (
                        <div className="text-muted">
                          <strong>Evidence:</strong> {c.evidence.join(' · ')}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      {/* Plan modal */}
      {selectedPlan && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setSelectedPlan(null)}>
          <div className="bg-surface border border-border rounded-lg max-w-3xl w-full max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-border flex items-center gap-2">
              <Hammer className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-medium">Build plan: {selectedPlan.capabilityTitle}</h3>
              <button onClick={() => setSelectedPlan(null)} className="ml-auto text-muted hover:text-primary">×</button>
            </div>
            <div className="p-5 space-y-4 text-sm">
              <div className="text-muted">{selectedPlan.rationale}</div>

              <Sub title="Architecture">
                <Kv k="Services"      v={selectedPlan.architecture.services.join(', ') || '—'} />
                <Kv k="Routes"        v={selectedPlan.architecture.routes.join(', ') || '—'} />
                <Kv k="Tables"        v={selectedPlan.architecture.tables.join(', ') || '—'} />
                <Kv k="UI"            v={selectedPlan.architecture.ui.join(', ') || '—'} />
                <Kv k="Workers"       v={selectedPlan.architecture.workers.join(', ') || '—'} />
              </Sub>

              <Sub title="Tasks">
                <ol className="space-y-2 text-xs">
                  {selectedPlan.tasks.map((t, i) => (
                    <li key={i} className="border border-border rounded p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300">{t.phase}</span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300">{t.category}</span>
                        {t.requiresApproval && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">approval</span>}
                        <span className="flex-1">{t.title}</span>
                        <span className="text-muted font-mono">i:{t.impact} r:{t.risk}</span>
                      </div>
                      <div className="text-muted mt-1">{t.description}</div>
                    </li>
                  ))}
                </ol>
              </Sub>

              <Sub title="Agent assignments">
                <ul className="text-xs space-y-1">
                  {selectedPlan.agentAssignments.map(a => (
                    <li key={a.role}>
                      <span className="font-mono">{a.role}</span>
                      <span className={`ml-2 ${a.agentId ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {a.agentId ? `→ ${a.agentId.slice(0, 8)}…` : 'not seeded yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              </Sub>

              <Sub title="Approvals required">
                {selectedPlan.approvalsRequired.length === 0
                  ? <div className="text-muted text-xs">None — low-risk autonomous build</div>
                  : <ul className="text-xs list-disc list-inside text-amber-300">
                      {selectedPlan.approvalsRequired.map(a => <li key={a}>{a}</li>)}
                    </ul>}
              </Sub>

              <Sub title="Rollout">
                <ol className="text-xs list-decimal list-inside space-y-0.5">
                  {selectedPlan.rolloutPlan.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </Sub>

              <Sub title="Rollback">
                <ol className="text-xs list-decimal list-inside space-y-0.5">
                  {selectedPlan.rollbackPlan.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </Sub>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => persistPlan.mutate(selectedPlan.capabilityId)}
                  disabled={persistPlan.isPending}
                  className="text-xs px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                >
                  {persistPlan.isPending ? 'Persisting…' : 'Persist to roadmap_tasks'}
                </button>
                <button onClick={() => setSelectedPlan(null)} className="text-xs px-3 py-1.5 rounded border border-border">
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Sub({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{title}</div>
      {children}
    </div>
  )
}
function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted w-20">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  )
}
