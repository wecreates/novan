/**
 * Truth — reality anchoring view.
 *
 * Consumes:
 *   /truth/assumptions/summary
 *   /truth/assumptions[?status=...]
 *   /truth/drift/warnings
 *   /cognition/accuracy (ground-truth pass-rate trend proxy)
 *   /cognition/chains?kind=recommendation (epistemic classification of recents)
 */
import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ShieldCheck, AlertOctagon, Lightbulb, Search, Eye, EyeOff,
  CheckCircle2, XCircle, HelpCircle, RefreshCw, ChevronDown, ChevronRight,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface AssumptionSummary {
  unverified: number; verifying: number; verified: number; invalidated: number; stale: number
  avgConfidenceByStatus: Record<string, number>
}
interface Assumption {
  id: string; category: string; statement: string; status: string
  confidence: number; source: string; lastVerifiedAt: number | null
  verificationCount: number; invalidationCount: number; createdAt: number
}
interface DriftWarning {
  id: string; kind: string; subjectId: string | null; severity: string
  evidence: unknown[]; recommendedAction: string; appliedAction: string | null
  status: string; createdAt: number; resolvedAt: number | null
}
interface AccuracyReport {
  window: string; totalChains: number; withKnownOutcome: number
  matched: number; unmatched: number; matchRate: number | null
  calibrationGap: number | null
}
interface ChainRow {
  id: string; kind: string; decision: string; confidence: number | null
  outcomeKnown: boolean; outcomeMatched: boolean | null; createdAt: number
}

const STATUS_COLOR: Record<string, string> = {
  verified:    'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  unverified:  'bg-slate-500/20 text-slate-300 border-slate-500/40',
  verifying:   'bg-amber-500/20 text-amber-300 border-amber-500/40',
  invalidated: 'bg-red-500/20 text-red-300 border-red-500/40',
  stale:       'bg-amber-500/10 text-amber-400 border-amber-500/40',
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300',
  high:     'bg-amber-500/20 text-amber-300',
  medium:   'bg-sky-500/20 text-sky-300',
  low:      'bg-slate-500/20 text-slate-300',
}

function epistemicLabel(c: ChainRow): { label: string; color: string } {
  if (c.kind === 'forecast') return { label: 'speculative_forecast', color: 'text-purple-400' }
  const conf = c.confidence ?? 0
  if (c.outcomeKnown && c.outcomeMatched === true && conf >= 0.85)
    return { label: 'verified_fact', color: 'text-emerald-400' }
  if (conf >= 0.6)
    return { label: 'probable_conclusion', color: 'text-sky-400' }
  return { label: 'uncertain_assumption', color: 'text-amber-400' }
}

export default function TruthPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<'all' | 'verified' | 'unverified' | 'stale' | 'invalidated'>('all')
  const [expandedAssumption, setExpandedAssumption] = useState<string | null>(null)

  const summary = useQuery({
    queryKey: ['truth-summary', workspaceId],
    queryFn:  () => api.get<{ data: AssumptionSummary }>(`/api/v1/truth/assumptions/summary?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const assumptions = useQuery({
    queryKey: ['truth-assumptions', workspaceId, statusFilter],
    queryFn:  () => {
      const q = `workspace_id=${workspaceId}${statusFilter !== 'all' ? `&status=${statusFilter}` : ''}&limit=50`
      return api.get<{ data: Assumption[] }>(`/api/v1/truth/assumptions?${q}`)
    },
    refetchInterval: 60_000,
  })
  const warnings = useQuery({
    queryKey: ['truth-drift', workspaceId],
    queryFn:  () => api.get<{ data: DriftWarning[] }>(`/api/v1/truth/drift/warnings?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const accuracy = useQuery({
    queryKey: ['truth-accuracy', workspaceId],
    queryFn:  () => api.get<{ data: AccuracyReport }>(`/api/v1/cognition/accuracy?workspace_id=${workspaceId}`),
    refetchInterval: 5 * 60_000,
  })
  const recentChains = useQuery({
    queryKey: ['truth-recent-chains', workspaceId],
    queryFn:  () => api.get<{ data: ChainRow[] }>(`/api/v1/cognition/chains?workspace_id=${workspaceId}&kind=recommendation&limit=15`),
    refetchInterval: 60_000,
  })

  const scanDrift = useMutation({
    mutationFn: () => api.post<unknown>(`/api/v1/truth/drift/scan`, { workspace_id: workspaceId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['truth-drift', workspaceId] }) },
  })
  const correctDrift = useMutation({
    mutationFn: () => api.post<unknown>(`/api/v1/truth/correct`, { workspace_id: workspaceId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['truth-drift', workspaceId] }) },
  })
  const setAssumptionStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.post<unknown>(`/api/v1/truth/assumptions/${id}/status`, { workspace_id: workspaceId, status }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['truth-assumptions', workspaceId] })
      void qc.invalidateQueries({ queryKey: ['truth-summary', workspaceId] })
    },
  })

  const s = summary.data?.data
  const a = assumptions.data?.data ?? []
  const w = warnings.data?.data ?? []
  const acc = accuracy.data?.data
  const chains = recentChains.data?.data ?? []

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="w-6 h-6 text-emerald-400" />
        <div className="flex-1">
          <h1 className="text-xl font-medium text-[var(--text)]">Truth</h1>
          <p className="text-xs text-[var(--text-muted)]">Reality anchoring · assumptions · drift · ground-truth pass-rate</p>
        </div>
        <button
          onClick={() => scanDrift.mutate()}
          disabled={scanDrift.isPending}
          className="text-xs px-3 py-1.5 rounded border border-[var(--border)] hover:bg-[var(--bg-elevated)] flex items-center gap-1.5"
        >
          <Search className="w-3 h-3" />{scanDrift.isPending ? 'Scanning…' : 'Scan drift'}
        </button>
        <button
          onClick={() => correctDrift.mutate()}
          disabled={correctDrift.isPending || w.length === 0}
          className="text-xs px-3 py-1.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-50 flex items-center gap-1.5"
        >
          <RefreshCw className="w-3 h-3" />{correctDrift.isPending ? 'Correcting…' : `Apply corrections (${w.length})`}
        </button>
      </div>

      {/* Assumption status strip */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="verified" value={String(s.verified)} color="emerald" hint={s.avgConfidenceByStatus['verified'] ?? 0} />
          <Stat label="unverified" value={String(s.unverified)} color="slate" hint={s.avgConfidenceByStatus['unverified'] ?? 0} />
          <Stat label="verifying" value={String(s.verifying)} color="amber" hint={s.avgConfidenceByStatus['verifying'] ?? 0} />
          <Stat label="stale" value={String(s.stale)} color="amber" hint={s.avgConfidenceByStatus['stale'] ?? 0} />
          <Stat label="invalidated" value={String(s.invalidated)} color="red" hint={s.avgConfidenceByStatus['invalidated'] ?? 0} />
        </div>
      )}

      {/* Ground-truth + meta-reasoning numbers */}
      {acc && (
        <Section title="Ground-truth pass-rate" icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}>
          <div className="px-5 py-3 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Kv k="Chains tracked" v={String(acc.totalChains)} />
            <Kv k="With known outcome" v={String(acc.withKnownOutcome)} />
            <Kv k="Match rate" v={acc.matchRate === null ? '—' : `${(acc.matchRate*100).toFixed(0)}%`} />
            <Kv k="Calibration gap" v={acc.calibrationGap === null ? '—' : `${acc.calibrationGap > 0 ? '+' : ''}${(acc.calibrationGap*100).toFixed(1)}%`} />
          </div>
          {acc.withKnownOutcome < 10
            ? (
              <div className="px-5 pb-3 text-xs text-[var(--text-muted)]">
                Honest signal: pass-rate not meaningful until ≥10 known outcomes (currently {acc.withKnownOutcome}).
              </div>
            )
            : null}
        </Section>
      )}

      {/* Drift warnings */}
      <Section title={`Drift warnings (${w.length} open)`} icon={<AlertOctagon className="w-4 h-4 text-amber-400" />}>
        {w.length === 0 ? (
          <div className="px-5 py-6 text-[var(--text-muted)] text-sm">
            No open drift warnings. Reality and platform belief are aligned (or there's not enough data yet to detect drift).
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {w.map(warn => (
              <li key={warn.id} className="px-5 py-3 flex items-center gap-3">
                <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${SEVERITY_COLOR[warn.severity] ?? 'bg-slate-500/20 text-slate-300'}`}>
                  {warn.severity}
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">{warn.kind}</span>
                {warn.subjectId
                  ? <span className="text-xs font-mono text-sky-400 truncate max-w-[200px]">{warn.subjectId}</span>
                  : null}
                <span className="flex-1 text-xs text-[var(--text)]">{warn.recommendedAction}</span>
                {warn.appliedAction
                  ? <span className="text-[10px] text-emerald-400">applied: {warn.appliedAction.slice(0, 50)}</span>
                  : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Recent recommendations classified */}
      <Section title="Epistemic classification of recent recommendations" icon={<Lightbulb className="w-4 h-4" />}>
        {chains.length === 0 ? (
          <div className="px-5 py-6 text-[var(--text-muted)] text-sm">No recommendation chains yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {chains.map(c => {
              const ep = epistemicLabel(c)
              return (
                <li key={c.id} className="px-5 py-2 flex items-center gap-3 text-sm">
                  <span className={`text-[10px] font-mono uppercase tracking-wider ${ep.color}`}>{ep.label}</span>
                  <span className="flex-1 truncate">{c.decision}</span>
                  <span className="text-xs text-[var(--text-muted)] font-mono">conf {(c.confidence ?? 0).toFixed(2)}</span>
                  {c.outcomeKnown && (
                    c.outcomeMatched ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <XCircle className="w-3 h-3 text-red-400" />
                  )}
                  {!c.outcomeKnown && <HelpCircle className="w-3 h-3 text-[var(--text-muted)]" />}
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      {/* Assumptions list */}
      <Section title="Assumptions" icon={<Eye className="w-4 h-4" />} actions={
        <div className="flex gap-1 text-xs">
          {(['all', 'verified', 'unverified', 'stale', 'invalidated'] as const).map(f => (
            <button key={f} onClick={() => setStatusFilter(f)}
                    className={`px-2 py-1 rounded ${statusFilter === f ? 'bg-sky-500/20 text-sky-300' : 'text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]'}`}>
              {f}
            </button>
          ))}
        </div>
      }>
        {a.length === 0 ? (
          <div className="px-5 py-6 text-[var(--text-muted)] text-sm">
            No assumptions tracked at this filter. Recommendation-engine and forecasting now declare their own; check back after triggering them.
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {a.map(asm => {
              const expanded = expandedAssumption === asm.id
              return (
                <li key={asm.id} className="px-4 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setExpandedAssumption(expanded ? null : asm.id)}>
                      {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </button>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${STATUS_COLOR[asm.status] ?? STATUS_COLOR['unverified']!}`}>
                      {asm.status}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{asm.category}</span>
                    <span className="flex-1 truncate text-[var(--text)]">{asm.statement}</span>
                    <span className="text-xs text-[var(--text-muted)] font-mono">conf {asm.confidence.toFixed(2)}</span>
                  </div>
                  {expanded && (
                    <div className="mt-2 ml-7 text-xs space-y-1">
                      <div className="text-[var(--text-muted)]">Source: <span className="font-mono">{asm.source}</span></div>
                      <div className="text-[var(--text-muted)]">Verified {asm.verificationCount}× · invalidated {asm.invalidationCount}×</div>
                      <div className="flex gap-2 mt-2">
                        <button onClick={() => setAssumptionStatus.mutate({ id: asm.id, status: 'verified' })}
                                className="text-[10px] px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">Mark verified</button>
                        <button onClick={() => setAssumptionStatus.mutate({ id: asm.id, status: 'invalidated' })}
                                className="text-[10px] px-2 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-300">Invalidate</button>
                        <button onClick={() => setAssumptionStatus.mutate({ id: asm.id, status: 'verifying' })}
                                className="text-[10px] px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300">Re-verify</button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, icon, actions, children }: { title: string; icon?: JSX.Element; actions?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-[var(--text)]">{title}</h3>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

function Stat({ label, value, color, hint }: { label: string; value: string; color: 'emerald' | 'slate' | 'amber' | 'red'; hint?: number }) {
  const map = {
    emerald: 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300',
    slate:   'border-slate-500/40 bg-slate-500/5 text-slate-300',
    amber:   'border-amber-500/40 bg-amber-500/5 text-amber-300',
    red:     'border-red-500/40 bg-red-500/5 text-red-300',
  } as const
  return (
    <div className={`rounded-lg border ${map[color]} px-4 py-3`}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-mono mt-1">{value}</div>
      {hint !== undefined && hint > 0 && (
        <div className="text-[10px] opacity-60 mt-0.5">avg conf {hint.toFixed(2)}</div>
      )}
    </div>
  )
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{k}</div>
      <div className="font-mono text-sm">{v}</div>
    </div>
  )
}
