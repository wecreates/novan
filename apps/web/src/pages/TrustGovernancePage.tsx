/**
 * Trust + Governance — reputation dashboard, ethical blocks, agent pause,
 * override log, alignment confidence, operator sovereignty.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Shield, Pause, Play, AlertTriangle, ScrollText, RadioTower,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface TrustScore { subjectType: string; subjectId: string; score: number; signals: Array<{ at: number; reason: string; delta: number }>; updatedAt: number }
interface EthicalBlock { id: string; intent: string; source: string; category: string; reason: string; blockedAt: number }
interface PausedAgent { agentName: string; pausedBy: string | null; pausedAt: number | null; reason: string | null }
interface OverrideEntry { id: string; actionType: string; originalStatus: string; overrideStatus: string; operatorId: string | null; reason: string | null; createdAt: number }
interface Alignment {
  signals: Array<{ kind: string; severity: string; text: string }>
  alignmentConfidence: number
}
interface Sovereignty {
  ok: boolean
  invariants: Array<{ name: string; pass: boolean; detail: string }>
}

const SEV: Record<string, string> = {
  critical: 'text-red-300 bg-red-500/15 border-red-500/40',
  high:     'text-amber-300 bg-amber-500/15 border-amber-500/40',
  medium:   'text-sky-300 bg-sky-500/15 border-sky-500/40',
  low:      'text-slate-300 bg-slate-500/15 border-slate-500/40',
}

export default function TrustGovernancePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  const trust = useQuery({
    queryKey: ['trust', workspaceId],
    queryFn: () => api.get<{ data: TrustScore[] }>(`/api/v1/commerce/trust?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const blocks = useQuery({
    queryKey: ['ethical-blocks', workspaceId],
    queryFn: () => api.get<{ data: EthicalBlock[] }>(`/api/v1/commerce/governance/ethical-blocks?workspace_id=${workspaceId}&hours=24`),
    refetchInterval: 30_000,
  })
  const paused = useQuery({
    queryKey: ['paused-agents', workspaceId],
    queryFn: () => api.get<{ data: PausedAgent[] }>(`/api/v1/commerce/governance/paused-agents?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })
  const overrides = useQuery({
    queryKey: ['overrides', workspaceId],
    queryFn: () => api.get<{ data: OverrideEntry[] }>(`/api/v1/commerce/governance/overrides?workspace_id=${workspaceId}&limit=20`),
    refetchInterval: 60_000,
  })
  const alignment = useQuery({
    queryKey: ['alignment', workspaceId],
    queryFn: () => api.get<{ data: Alignment }>(`/api/v1/commerce/governance/alignment?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })
  const sov = useQuery({
    queryKey: ['sovereignty', workspaceId],
    queryFn: () => api.get<{ data: Sovereignty }>(`/api/v1/commerce/governance/sovereignty?workspace_id=${workspaceId}`),
    refetchInterval: 60_000,
  })

  const setPaused = useMutation({
    mutationFn: ({ agentName, paused }: { agentName: string; paused: boolean }) =>
      api.post(`/api/v1/commerce/governance/agent-pause`, { workspace_id: workspaceId, agent_name: agentName, paused, by: 'operator' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paused-agents', workspaceId] }),
  })

  const a = alignment.data?.data
  const s = sov.data?.data
  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-emerald-400" />
        <h1 className="text-xl font-semibold">Trust & Governance</h1>
        <span className="text-xs text-muted ml-1">reputation · ethics · alignment · operator sovereignty</span>
      </div>

      {/* Alignment + Sovereignty header */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Section title="Alignment confidence" icon={<RadioTower className="w-4 h-4 text-sky-400" />}>
          {a ? (
            <div className="p-4 space-y-2">
              <div className="text-3xl font-mono">{(a.alignmentConfidence * 100).toFixed(0)}%</div>
              {a.signals.length === 0 ? (
                <p className="text-xs text-emerald-300">No drift signals.</p>
              ) : (
                <ul className="text-xs space-y-1">
                  {a.signals.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] border ${SEV[s.severity] ?? SEV.medium}`}>{s.severity}</span>
                      <span>{s.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : <Empty msg="loading…" />}
        </Section>

        <Section title="Operator sovereignty invariants" icon={<Shield className="w-4 h-4 text-emerald-400" />}>
          {s ? (
            <ul className="p-4 space-y-1 text-xs">
              {s.invariants.map((i, idx) => (
                <li key={idx} className="flex items-center gap-2">
                  <span className={i.pass ? 'text-emerald-400' : 'text-red-400'}>{i.pass ? '✓' : '✗'}</span>
                  <span className="font-mono">{i.name}</span>
                  <span className="text-muted ml-auto text-[10px]">{i.detail}</span>
                </li>
              ))}
            </ul>
          ) : <Empty msg="loading…" />}
        </Section>
      </div>

      {/* Trust scores */}
      <Section title={`Trust scores (${trust.data?.data.length ?? 0}, lowest first)`} icon={<Shield className="w-4 h-4 text-sky-400" />}>
        {(trust.data?.data ?? []).length === 0 ? <Empty msg="No trust scores yet — auto-derive cron runs hourly." /> : (
          <ul className="divide-y divide-[var(--border)]">
            {trust.data!.data.slice(0, 20).map(t => (
              <li key={`${t.subjectType}/${t.subjectId}`} className="px-4 py-2 text-xs flex items-center gap-3">
                <span className="text-[10px] uppercase tracking-wider text-muted w-32">{t.subjectType}</span>
                <span className="font-mono flex-1 truncate">{t.subjectId}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.score < 0.4 ? 'text-red-300 bg-red-500/10' : t.score < 0.7 ? 'text-amber-300 bg-amber-500/10' : 'text-emerald-300 bg-emerald-500/10'}`}>
                  {(t.score * 100).toFixed(0)}%
                </span>
                <span className="text-[10px] text-muted">{t.signals.length} signals</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Paused agents */}
        <Section title={`Paused agents (${paused.data?.data.length ?? 0})`} icon={<Pause className="w-4 h-4 text-amber-400" />}>
          {(paused.data?.data ?? []).length === 0 ? <Empty msg="No paused agents." /> : (
            <ul className="divide-y divide-[var(--border)]">
              {paused.data!.data.map(p => (
                <li key={p.agentName} className="px-4 py-2 text-xs flex items-center gap-2">
                  <span className="font-mono flex-1">{p.agentName}</span>
                  <span className="text-[10px] text-muted" title={p.reason ?? ''}>{p.reason?.slice(0, 30) ?? ''}</span>
                  <button onClick={() => setPaused.mutate({ agentName: p.agentName, paused: false })}
                    className="p-1 hover:bg-emerald-500/10 rounded" title="Resume">
                    <Play className="w-3.5 h-3.5 text-emerald-400" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent overrides */}
        <Section title={`Operator overrides (${overrides.data?.data.length ?? 0})`} icon={<ScrollText className="w-4 h-4 text-purple-400" />}>
          {(overrides.data?.data ?? []).length === 0 ? <Empty msg="No overrides recorded." /> : (
            <ul className="divide-y divide-[var(--border)]">
              {overrides.data!.data.slice(0, 8).map(o => (
                <li key={o.id} className="px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-muted w-24">{new Date(o.createdAt).toLocaleDateString()}</span>
                    <span className="font-mono">{o.actionType}</span>
                    <span className="text-muted">{o.originalStatus} → {o.overrideStatus}</span>
                  </div>
                  {o.reason && <p className="text-[10px] text-muted mt-0.5">{o.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Ethical blocks */}
      <Section title={`Ethical blocks (24h, ${blocks.data?.data.length ?? 0})`} icon={<AlertTriangle className="w-4 h-4 text-red-400" />}>
        {(blocks.data?.data ?? []).length === 0 ? (
          <div className="px-4 py-3 text-xs text-emerald-300">No ethical blocks in 24h.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {blocks.data!.data.slice(0, 12).map(b => (
              <li key={b.id} className="px-4 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/10 text-red-300">{b.category}</span>
                  <span className="font-mono text-muted">{b.source}</span>
                  <span className="text-[10px] text-muted ml-auto">{new Date(b.blockedAt).toLocaleString().replace(',', '')}</span>
                </div>
                <p className="mt-0.5 truncate" title={b.intent}>{b.intent}</p>
                <p className="text-[10px] text-amber-300 mt-0.5">{b.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: JSX.Element; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-muted italic">{msg}</div>
}
