/**
 * Home — single landing dashboard.
 *
 * Replaces operator scanning 15 pages with one "what changed / what
 * needs attention" view.
 */
import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import {
  Heart, AlertOctagon, Code2, Coins, Brain, Activity, Target, ChevronRight,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface HomePayload {
  generatedAt: number
  runtime: { liveness: 'live' | 'stale'; uptimeHuman: string; cronCount: number; memoryMb: number }
  attentionItems: Array<{ kind: string; severity: string; text: string; ref?: string }>
  counts: {
    openDriftWarnings: number; pendingProposals: number; pendingPrefs: number
    activeHorizons: number; recentRejections24h: number
  }
  activeHorizons: Array<{ id: string; title: string; horizon: string }>
  recentMindDecisions: Array<{ id: string; decision: string; createdAt: number }>
  recentEvents: Array<{ type: string; createdAt: number }>
  notes: string[]
}

const SEV: Record<string, string> = {
  critical: 'text-red-300 bg-red-500/15 border-red-500/40',
  high:     'text-amber-300 bg-amber-500/15 border-amber-500/40',
  medium:   'text-sky-300 bg-sky-500/15 border-sky-500/40',
  low:      'text-slate-300 bg-slate-500/15 border-slate-500/40',
}

const KIND_LINK: Record<string, string> = {
  drift_warning:       '/truth',
  code_proposal:       '/proposals',
  provider_preference: '/economy',
  runtime_stale:       '/runtime',
}

export default function HomeDashboardPage() {
  const { workspaceId } = useWorkspace()
  const home = useQuery({
    queryKey: ['home', workspaceId],
    queryFn:  () => api.get<{ data: HomePayload }>(`/api/v1/self/home?workspace_id=${workspaceId}`),
    refetchInterval: 30_000,
  })
  const d = home.data?.data

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Heart className={`w-5 h-5 ${d?.runtime.liveness === 'live' ? 'text-emerald-400 animate-pulse' : 'text-slate-500'}`} />
        <h1 className="text-xl font-semibold">Home</h1>
        <span className="text-xs text-muted ml-1">{d ? `${d.runtime.liveness} · uptime ${d.runtime.uptimeHuman} · ${d.runtime.cronCount} crons · ${d.runtime.memoryMb}MB` : 'loading…'}</span>
      </div>

      {d && d.attentionItems.length === 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-sm text-emerald-300">
          Nothing needs your attention right now. The platform is running itself.
        </div>
      )}

      {d && d.attentionItems.length > 0 && (
        <Section title={`Needs attention (${d.attentionItems.length})`} icon={<AlertOctagon className="w-4 h-4 text-amber-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {d.attentionItems.map((item, i) => (
              <li key={i} className="px-4 py-2.5 text-sm flex items-center gap-3">
                <span className={`px-1.5 py-0.5 rounded text-[10px] border ${SEV[item.severity] ?? SEV.medium}`}>{item.severity}</span>
                <span className="text-xs text-muted font-mono">{item.kind}</span>
                <span className="flex-1">{item.text}</span>
                {KIND_LINK[item.kind] && (
                  <NavLink to={KIND_LINK[item.kind]!} className="text-xs text-sky-400 hover:underline flex items-center gap-0.5">
                    open <ChevronRight className="w-3 h-3" />
                  </NavLink>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Counts strip */}
      {d && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Count label="Drift open"        value={d.counts.openDriftWarnings} link="/truth" />
          <Count label="Code proposals"    value={d.counts.pendingProposals} link="/proposals" />
          <Count label="Pending swaps"     value={d.counts.pendingPrefs} link="/economy" />
          <Count label="Active horizons"   value={d.counts.activeHorizons} />
          <Count label="Rejections (24h)"  value={d.counts.recentRejections24h} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Strategic horizons */}
        <Section title="Active strategic horizons" icon={<Target className="w-4 h-4 text-purple-400" />}>
          {(d?.activeHorizons ?? []).length === 0 ? (
            <Empty msg="No active horizons — create one to align the autonomous mind." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {d!.activeHorizons.map(h => (
                <li key={h.id} className="px-4 py-2 text-sm flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted w-12">{h.horizon}</span>
                  <span>{h.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent mind decisions */}
        <Section title="Autonomous mind — recent decisions" icon={<Brain className="w-4 h-4 text-sky-400" />}>
          {(d?.recentMindDecisions ?? []).length === 0 ? (
            <Empty msg="No recent autonomous decisions — mind cycle runs every 10min." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {d!.recentMindDecisions.slice(0, 6).map(c => (
                <li key={c.id} className="px-4 py-2 text-xs">
                  <span className="font-mono text-muted">{new Date(c.createdAt).toLocaleTimeString()}</span>
                  <span className="ml-2">{c.decision}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Notes */}
      {d && d.notes.length > 0 && (
        <Section title="Notes" icon={<Activity className="w-4 h-4 text-slate-400" />}>
          <ul className="px-4 py-2 text-xs text-muted space-y-0.5">
            {d.notes.map((n, i) => <li key={i}>• {n}</li>)}
          </ul>
        </Section>
      )}
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

function Count({ label, value, link }: { label: string; value: number; link?: string }) {
  const Body = (
    <div className={`rounded-lg border border-border bg-surface px-3 py-2 ${link ? 'hover:bg-[var(--surface-hover)] cursor-pointer' : ''}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`font-mono mt-0.5 text-lg ${value > 0 ? '' : 'text-muted'}`}>{value}</div>
    </div>
  )
  return link ? <NavLink to={link}>{Body}</NavLink> : Body
}

function Empty({ msg }: { msg: string }) {
  return <div className="px-4 py-3 text-xs text-muted italic">{msg}</div>
}
