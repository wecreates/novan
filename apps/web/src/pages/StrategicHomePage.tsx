/**
 * Strategic Home — minimal first-screen War Room view.
 *
 * Renders the new intelligence endpoints:
 *   - /intelligence/war-room/home
 *   - /governance/snapshot
 *   - /explain/top
 *   - /governance/notifications/drivers
 *
 * Premium / minimal / mission-focused. No dashboard clutter.
 */
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link }                from 'react-router-dom'
import {
  AlertOctagon, AlertTriangle, CheckCircle2, Target, Brain,
  TrendingUp, Activity, Bell, Shield, ChevronRight, Clock, Check, X,
} from 'lucide-react'
import { intelligenceApi, enhancementsApi, type ExplanationDTO } from '../api.js'
import { VoiceCommandBar } from '../components/VoiceCommandBar.js'
import { MissingKeysBanner } from '../components/MissingKeysBanner.js'
import { setTheme, currentTheme } from '../hooks/useThemeAndShortcuts.js'
import { Sun, Moon } from 'lucide-react'

import { useWorkspace } from '../contexts/WorkspaceContext.js'

const LAST_VISIT_KEY = 'novan:last_visit_at'

function fmtTime(n: number | null | undefined): string {
  if (!n) return '—'
  const s = Math.floor((Date.now() - n) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

function bucketColor(b: string): string {
  switch (b) {
    case 'P0': return 'text-red-400 border-red-500/40 bg-red-500/10'
    case 'P1': return 'text-amber-400 border-amber-500/40 bg-amber-500/10'
    case 'P2': return 'text-sky-400 border-sky-500/40 bg-sky-500/10'
    default:   return 'text-slate-400 border-slate-500/30 bg-slate-500/10'
  }
}

function headlineStyle(status: string): { icon: JSX.Element; class: string; label: string } {
  if (status === 'critical') {
    return {
      icon: <AlertOctagon className="w-5 h-5" />,
      class: 'border-red-500/40 bg-red-500/10 text-red-300',
      label: 'CRITICAL',
    }
  }
  if (status === 'attention_needed') {
    return {
      icon: <AlertTriangle className="w-5 h-5" />,
      class: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
      label: 'ATTENTION',
    }
  }
  return {
    icon: <CheckCircle2 className="w-5 h-5" />,
    class: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    label: 'HEALTHY',
  }
}

export default function StrategicHomePage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [lastVisit, setLastVisit] = useState<number | null>(null)
  const [actedOn, setActedOn] = useState<Record<string, string>>({})

  const actOn = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      enhancementsApi.actOnRecommendation(workspaceId, id, action),
    onSuccess: (_d, vars) => {
      setActedOn(s => ({ ...s, [vars.id]: vars.action }))
      void qc.invalidateQueries({ queryKey: ['strategic-home', workspaceId] })
    },
  })

  useEffect(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_VISIT_KEY) : null
    setLastVisit(stored ? Number(stored) : null)
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_VISIT_KEY, String(Date.now()))
    }
  }, [])

  const home = useQuery({
    queryKey: ['strategic-home', workspaceId, lastVisit ?? 0],
    queryFn: () => intelligenceApi.home(workspaceId),
    refetchInterval: 60_000,
  })

  const gov = useQuery({
    queryKey: ['governance-snapshot', workspaceId],
    queryFn: () => intelligenceApi.governance(workspaceId),
    refetchInterval: 60_000,
  })

  const explain = useQuery({
    queryKey: ['explain-top', workspaceId],
    queryFn: () => intelligenceApi.explainTop(workspaceId, 5),
    refetchInterval: 120_000,
  })

  const drivers = useQuery({
    queryKey: ['notify-drivers'],
    queryFn: () => intelligenceApi.notificationDrivers(),
    refetchInterval: 5 * 60_000,
  })

  if (home.isLoading) {
    return <div className="p-8 text-muted">Loading…</div>
  }
  if (home.error || !home.data) {
    return <div className="p-8 text-red-400">Could not load strategic home: {(home.error as Error)?.message ?? 'no data'}</div>
  }

  const d = home.data.data
  const headline = headlineStyle(d.headline.status)
  const explanations = explain.data?.data ?? []
  const expByRecId = new Map(explanations.map(e => [e.recommendationId, e]))
  const g = gov.data?.data
  const configuredDrivers = drivers.data?.data.configured ?? []

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Missing keys banner */}
      <MissingKeysBanner />

      {/* Top toolbar: voice + theme */}
      <div className="flex items-center gap-3">
        <div className="flex-1" />
        <VoiceCommandBar />
        <button
          onClick={() => setTheme(currentTheme() === 'light' ? 'dark' : 'light')}
          title="Toggle theme (or press 't')"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-muted hover:bg-elevated"
        >
          {currentTheme() === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
      </div>

      {/* Headline */}
      <div className={`flex items-center gap-3 px-5 py-4 rounded-lg border ${headline.class}`}>
        {headline.icon}
        <div>
          <div className="text-xs font-mono uppercase tracking-wider opacity-80">{headline.label}</div>
          <div className="text-lg font-medium">{d.headline.summary}</div>
        </div>
        <div className="ml-auto text-xs opacity-60">composed {fmtTime(d.composedAt)}</div>
      </div>

      {/* Critical strip */}
      <div className="grid grid-cols-3 gap-3">
        <SignalCard label="Open critical incidents" value={d.unresolvedCritical.openIncidents}
          color={d.unresolvedCritical.openIncidents > 0 ? 'red' : 'green'} link="/incidents" />
        <SignalCard label="Pending approvals" value={d.unresolvedCritical.pendingApprovals}
          color={d.unresolvedCritical.pendingApprovals > 0 ? 'amber' : 'green'} link="/approvals" />
        <SignalCard label="Security audit items" value={d.unresolvedCritical.securityAudit}
          color={d.unresolvedCritical.securityAudit > 0 ? 'amber' : 'green'} link="/audit" />
      </div>

      {/* Top Recommendations */}
      <Section title="Top Recommendations" subtitle={`${d.topRecommendations.length} prioritized actions`}>
        {d.topRecommendations.length === 0 ? (
          <EmptyRow text="No recommendations — system is in operator-driven mode." />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {d.topRecommendations.map(r => {
              const e = expByRecId.get(r.id)
              const acted = actedOn[r.id]
              return (
                <li key={r.id} className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <span className={`text-xs font-mono px-2 py-1 rounded border ${bucketColor(r.decision.bucket)}`}>
                      {r.decision.bucket}
                    </span>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-primary">{r.title}</div>
                      <div className="text-xs text-muted mt-1">
                        {r.kind.replace(/_/g, ' ')}  ·  impact: {r.estimatedImpact}  ·  score {r.decision.score.toFixed(2)}
                      </div>
                      {/* Operator action buttons — log a recommendation.acted_on event */}
                      {acted ? (
                        <div className="mt-2 text-xs text-emerald-400">
                          ✓ logged: {acted}
                        </div>
                      ) : (
                        <div className="mt-2 flex gap-2">
                          <button
                            disabled={actOn.isPending}
                            onClick={() => actOn.mutate({ id: r.id, action: 'accepted' })}
                            className="text-xs px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 flex items-center gap-1"
                          >
                            <Check className="w-3 h-3" /> Accept
                          </button>
                          <button
                            disabled={actOn.isPending}
                            onClick={() => actOn.mutate({ id: r.id, action: 'deferred' })}
                            className="text-xs px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                          >
                            Defer
                          </button>
                          <button
                            disabled={actOn.isPending}
                            onClick={() => actOn.mutate({ id: r.id, action: 'dismissed' })}
                            className="text-xs px-2 py-1 rounded border border-slate-500/40 bg-slate-500/10 text-slate-300 hover:bg-slate-500/20 flex items-center gap-1"
                          >
                            <X className="w-3 h-3" /> Dismiss
                          </button>
                        </div>
                      )}
                      {e && (
                        <details className="mt-2">
                          <summary className="text-xs text-sky-400 cursor-pointer hover:text-sky-300">
                            why this matters →
                          </summary>
                          <div className="mt-2 pl-3 border-l border-border text-xs space-y-1">
                            <div className="text-muted">
                              <strong className="text-primary">If ignored:</strong> {e.whatHappensIfIgnored}
                              <span className="ml-2 opacity-50">(heuristic template, not a model forecast)</span>
                            </div>
                            <div className="text-muted">
                              <strong className="text-primary">Confidence:</strong> {(e.score * 100).toFixed(0)}%
                              <span className="ml-2 opacity-50">({e.confidenceProvenance.replace('_', '-')})</span>
                            </div>
                            <div className="text-muted">
                              <strong className="text-primary">Rollback:</strong>{' '}
                              {e.rollbackProven ? 'proven (used before)' : 'engine available, never exercised on this workspace'}
                            </div>
                            {e.risks.length > 0 && (
                              <div className="text-muted">
                                <strong className="text-primary">Risks:</strong> {e.risks.join('; ')}
                              </div>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Missions */}
        <Section title="Missions" icon={<Target className="w-4 h-4" />}>
          <MissionsList missions={d.missions} />
        </Section>

        {/* Since Last Visit */}
        <Section title={lastVisit ? 'Since Last Visit' : 'Last 24 Hours'} icon={<Clock className="w-4 h-4" />}>
          <SinceLastVisit data={d.sinceLastVisit} lastVisit={lastVisit} />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Accomplishments */}
        <Section title="Agent Accomplishments (24h)" icon={<Activity className="w-4 h-4" />}>
          {d.accomplishments24h.length === 0 ? (
            <EmptyRow text="No autonomous activity in the last 24 hours." />
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {d.accomplishments24h.map(a => (
                <li key={a.kind} className="px-5 py-2 flex items-center justify-between text-sm">
                  <span className="text-primary">{a.kind.replace(/_/g, ' ')}</span>
                  <span className="text-muted font-mono">
                    {a.count}  ·  {fmtTime(a.latestAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Governance & Stability */}
        <Section title="Governance" icon={<Shield className="w-4 h-4" />}>
          {g ? (
            <div className="px-5 py-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted">Stability</span>
                <span className={g.stability.overall === 'stable' ? 'text-emerald-400' :
                                 g.stability.overall === 'attention' ? 'text-amber-400' : 'text-red-400'}>
                  {g.stability.overall}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Auto-throttle</span>
                <span className={g.stability.recommendedThrottle ? 'text-red-400' : 'text-emerald-400'}>
                  {g.stability.recommendedThrottle ? 'engaged' : 'idle'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Auto-patches today</span>
                <span className="font-mono">
                  {g.runtimeGovernor.dailyCounters.autonomousPatchesToday} / {g.runtimeGovernor.dailyCounters.limits.maxAutonomousPatches}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Deployments today</span>
                <span className="font-mono">
                  {g.runtimeGovernor.dailyCounters.deploymentsToday} / {g.runtimeGovernor.dailyCounters.limits.maxDeployments}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t border-border">
                <span className="text-muted flex items-center gap-1.5"><Bell className="w-3 h-3" />Notification drivers</span>
                <span className="font-mono text-xs">
                  {configuredDrivers.length === 0 ? <span className="text-amber-400">none configured</span> : configuredDrivers.join(', ')}
                </span>
              </div>
            </div>
          ) : (
            <div className="px-5 py-4 text-muted text-sm">Loading…</div>
          )}
        </Section>
      </div>
    </div>
  )
}

function Section({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: JSX.Element; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium text-primary">{title}</h3>
        {subtitle && <span className="text-xs text-muted ml-2">{subtitle}</span>}
      </div>
      {children}
    </div>
  )
}

function SignalCard({ label, value, color, link }: { label: string; value: number; color: 'red' | 'amber' | 'green'; link: string }) {
  const colorClass = color === 'red'   ? 'border-red-500/40 bg-red-500/5 text-red-300' :
                     color === 'amber' ? 'border-amber-500/40 bg-amber-500/5 text-amber-300' :
                                         'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
  return (
    <Link to={link} className={`block rounded-lg border ${colorClass} px-4 py-3 hover:opacity-90 transition`}>
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-2xl font-mono mt-1">{value}</div>
    </Link>
  )
}

function MissionsList({ missions }: { missions: { active: Array<{ id: string; title: string; horizon: string; progress: number }>; blocked: Array<{ id: string; title: string; horizon: string }>; completed: Array<{ id: string; title: string }>; pendingApprovals: number } }) {
  const all = [
    ...missions.active.map(m => ({ ...m, status: 'active' as const })),
    ...missions.blocked.map(m => ({ ...m, progress: 0, status: 'blocked' as const })),
  ]
  if (all.length === 0) {
    return <EmptyRow text="No missions defined." />
  }
  return (
    <ul className="divide-y divide-[var(--border)]">
      {all.map(m => (
        <li key={m.id} className="px-5 py-3 flex items-center gap-3">
          <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${
            m.status === 'blocked' ? 'bg-amber-500/20 text-amber-300' : 'bg-sky-500/20 text-sky-300'
          }`}>
            {m.horizon}
          </span>
          <span className="flex-1 text-sm text-primary truncate">{m.title}</span>
          {m.status === 'active' && (
            <span className="text-xs text-muted font-mono">
              {Math.round((m.progress ?? 0) * 100)}%
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function SinceLastVisit({ data, lastVisit }: { data: { newIncidents: number; resolvedIncidents: number; newResearchFindings: number; newApprovals: number; newRoadmapItems: number; newFeedback: number; rollbacks: number; failureRateDelta: number | null }; lastVisit: number | null }) {
  const rows: Array<[string, number, string?]> = [
    ['New incidents',          data.newIncidents,          data.newIncidents > 0 ? 'text-amber-400' : ''],
    ['Resolved incidents',     data.resolvedIncidents,     'text-emerald-400'],
    ['New research findings',  data.newResearchFindings],
    ['New roadmap items',      data.newRoadmapItems],
    ['New approvals',          data.newApprovals],
    ['New feedback',           data.newFeedback],
    ['Rollbacks',              data.rollbacks,             data.rollbacks > 0 ? 'text-amber-400' : ''],
  ]
  return (
    <div className="px-5 py-2 space-y-1.5 text-sm">
      {!lastVisit && (
        <div className="text-xs text-muted mb-2">First visit detected — showing last 24h.</div>
      )}
      {rows.map(([label, value, cls]) => (
        <div key={label} className="flex justify-between">
          <span className="text-muted">{label}</span>
          <span className={`font-mono ${cls ?? 'text-primary'}`}>{value}</span>
        </div>
      ))}
      {data.failureRateDelta !== null && (
        <div className="flex justify-between pt-1 border-t border-border mt-2">
          <span className="text-muted">Failure rate trend</span>
          <span className={`font-mono ${data.failureRateDelta > 0 ? 'text-amber-400' : data.failureRateDelta < 0 ? 'text-emerald-400' : ''}`}>
            {data.failureRateDelta > 0 ? '+' : ''}{(data.failureRateDelta * 100).toFixed(1)}%
          </span>
        </div>
      )}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-5 py-6 text-muted text-sm">{text}</div>
}
