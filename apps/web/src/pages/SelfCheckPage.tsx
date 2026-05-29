/**
 * SelfCheckPage — the brain's continuous platform self-check, made
 * visible. Reads from /api/v1/self/platform-smoke + /platform-smoke/runs.
 *
 * Surfaces:
 *   - latest run's ok/fail/slow counts
 *   - any regressions (paths that were OK previously but now broken)
 *   - per-probe table with status + latency
 *   - "Run now" button (POST to trigger an on-demand sweep)
 *   - history of recent runs
 *
 * Honest scope:
 *   - Read-only display. The actual checks run server-side every
 *     15 min via learning-cron; this page just shows what the brain
 *     found and lets the operator force a fresh sweep.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2, AlertTriangle, AlertOctagon, Clock, RefreshCw, Loader2,
  TrendingDown, Activity, Users,
} from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'
import { EmptyState } from '../components/EmptyState.js'

interface Probe {
  path:        string
  status:      number
  ms:          number
  bodyExcerpt: string
}

interface SmokeRun {
  id:          string
  ranAt:       number
  durationMs:  number
  okCount:     number
  failCount:   number
  slowCount:   number
  probes:      Probe[]
  regressions: Array<{ path: string; prevStatus: number; nowStatus: number }>
}

interface TeamCronStatus {
  eventType:   string
  label:       string
  intervalMs:  number
  lastRanAt:   number | null
  ranAgoMs:    number | null
  health:      'healthy' | 'stale' | 'pending'
  lastPayload: Record<string, unknown>
}
interface TeamStatus {
  id: string; name: string; charter: string
  crons: TeamCronStatus[]
  recentErrors: Array<{ at: number; task: string; message: string }>
}

interface RunSummary {
  id: string; ranAt: number; durationMs: number
  okCount: number; failCount: number; slowCount: number
  regressionCount: Array<unknown>     // jsonb stored as array; UI uses length
  source: string
}

export default function SelfCheckPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'failures' | 'slow'>('all')

  const latest = useQuery({
    queryKey: ['platform-smoke-latest', workspaceId],
    queryFn:  () => api.get<{ data: SmokeRun | null }>(`/api/v1/self/platform-smoke?workspace_id=${workspaceId}`)
                       .then(r => r.data),
    refetchInterval: 30_000,
  })

  const teams = useQuery({
    queryKey: ['self-teams', workspaceId],
    queryFn:  () => api.get<{ data: TeamStatus[] }>(`/api/v1/self/teams?workspace_id=${workspaceId}`)
                       .then(r => r.data),
    refetchInterval: 30_000,
  })

  const history = useQuery({
    queryKey: ['platform-smoke-history', workspaceId],
    queryFn:  () => api.get<{ data: RunSummary[] }>(`/api/v1/self/platform-smoke/runs?workspace_id=${workspaceId}&limit=20`)
                       .then(r => r.data),
  })

  const runNow = useMutation({
    mutationFn: () => api.post<{ data: SmokeRun }>(`/api/v1/self/platform-smoke`, { workspace_id: workspaceId })
                         .then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-smoke-latest', workspaceId] })
      qc.invalidateQueries({ queryKey: ['platform-smoke-history', workspaceId] })
    },
  })

  const run = latest.data ?? null
  const probes = run?.probes ?? []
  const filtered = probes.filter(p => {
    if (filter === 'failures') return p.status === 0 || p.status === 404 || p.status >= 500
    if (filter === 'slow')     return p.status >= 200 && p.status < 300 && p.ms >= 3_000
    return true
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        breadcrumb="Brain · Self-check"
        title="Platform Self-check"
        subtitle="The brain exercises every public GET route every 15 minutes and persists the results. Regressions emit incidents the self-healing loop picks up."
        actions={
          <button onClick={() => runNow.mutate()}
            disabled={runNow.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[12px] text-[var(--accent-active)] focus-ring disabled:opacity-40">
            {runNow.isPending
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running…</>
              : <><RefreshCw className="w-3.5 h-3.5" /> Run now</>}
          </button>
        }
      />

      {!run && !latest.isLoading && (
        <EmptyState
          icon={<Activity className="w-8 h-8" />}
          title="No smoke runs yet"
          description="The platform self-check cron runs every 15 minutes. Click ‘Run now’ to trigger a sweep immediately."
        />
      )}

      {run && (
        <>
          {/* Counters */}
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Counter label="OK"    value={run.okCount}   tone="healthy" icon={<CheckCircle2 className="w-3.5 h-3.5" />} />
            <Counter label="Slow"  value={run.slowCount} tone="warning" icon={<Clock className="w-3.5 h-3.5" />} />
            <Counter label="Fail"  value={run.failCount} tone={run.failCount > 0 ? 'critical' : 'muted'} icon={<AlertOctagon className="w-3.5 h-3.5" />} />
            <Counter label="Regressions" value={run.regressions.length} tone={run.regressions.length > 0 ? 'critical' : 'muted'} icon={<TrendingDown className="w-3.5 h-3.5" />} />
          </section>

          <div className="text-[11px] text-[var(--text-muted)] mb-4">
            Last run {new Date(run.ranAt).toLocaleString()} · took {run.durationMs.toLocaleString()} ms · {probes.length} probes
          </div>

          {/* Regressions banner */}
          {run.regressions.length > 0 && (
            <section className="panel p-4 mb-4 border-[var(--accent-critical)]/40">
              <h2 className="text-[12px] font-semibold text-[var(--accent-critical)] flex items-center gap-1.5 mb-2">
                <AlertTriangle className="w-3.5 h-3.5" /> Regressions
              </h2>
              <ul className="space-y-1">
                {run.regressions.map(r => (
                  <li key={r.path} className="text-[12px] font-mono text-[var(--text-secondary)]">
                    <span className="text-[var(--text-muted)]">{r.prevStatus}</span>
                    <span className="mx-1 text-[var(--text-faint)]">→</span>
                    <span className="text-[var(--accent-critical)]">{r.nowStatus}</span>
                    <span className="ml-2 text-[var(--text-primary)]">{r.path}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Filters */}
          <div className="flex items-center gap-1 mb-2 text-[11px]">
            <FilterTab active={filter === 'all'}      onClick={() => setFilter('all')}>All ({probes.length})</FilterTab>
            <FilterTab active={filter === 'failures'} onClick={() => setFilter('failures')}>Failures ({run.failCount})</FilterTab>
            <FilterTab active={filter === 'slow'}     onClick={() => setFilter('slow')}>Slow ({run.slowCount})</FilterTab>
          </div>

          {/* Probes table */}
          <section className="panel overflow-hidden">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--bg-elevated)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium w-16">Status</th>
                  <th className="text-left px-3 py-1.5 font-medium w-20">Latency</th>
                  <th className="text-left px-3 py-1.5 font-medium">Path</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => (
                  <tr key={p.path} className="border-t border-[var(--border)] hover:bg-[var(--surface-hover)]">
                    <td className="px-3 py-1 font-mono">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className={`px-3 py-1 font-mono ${p.ms >= 3000 ? 'text-[var(--accent-warning)]' : 'text-[var(--text-muted)]'}`}>
                      {p.ms.toLocaleString()}ms
                    </td>
                    <td className="px-3 py-1 font-mono text-[var(--text-secondary)] truncate" title={p.path}>{p.path}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-[var(--text-muted)] text-[11px]">No probes match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Teams — what cyber/eng/orchestration/observability are doing */}
          {teams.data && teams.data.length > 0 && (
            <section className="mt-5">
              <h2 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <Users className="w-3 h-3" /> Continuously-running teams
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {teams.data.map(team => <TeamCard key={team.id} team={team} />)}
              </div>
            </section>
          )}

          {/* History */}
          {(history.data?.length ?? 0) > 1 && (
            <section className="mt-5">
              <h2 className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1.5">
                <Clock className="w-3 h-3" /> Recent runs
              </h2>
              <div className="space-y-1">
                {history.data!.slice(0, 10).map(h => (
                  <div key={h.id} className="panel p-2 flex items-center gap-3 text-[11px]">
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      h.failCount > 0 ? 'bg-[var(--accent-critical)]' :
                      h.slowCount > 0 ? 'bg-[var(--accent-warning)]' :
                                        'bg-[var(--accent-healthy)]'
                    }`} />
                    <span className="text-[var(--text-muted)] w-32 shrink-0 truncate font-mono">{new Date(h.ranAt).toLocaleString()}</span>
                    <span className="text-[var(--text-secondary)]">
                      {h.okCount} ok · {h.slowCount} slow · {h.failCount} fail
                    </span>
                    <span className="text-[var(--text-faint)] ml-auto uppercase text-[10px]">{h.source}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function Counter({ label, value, tone, icon }: {
  label: string; value: number; tone: 'healthy'|'warning'|'critical'|'muted'; icon: React.ReactNode
}) {
  const color = tone === 'healthy'  ? 'var(--accent-healthy)'
              : tone === 'warning'  ? 'var(--accent-warning)'
              : tone === 'critical' ? 'var(--accent-critical)'
                                    : 'var(--text-muted)'
  return (
    <div className="panel p-3">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider mb-1" style={{ color }}>
        {icon} {label}
      </div>
      <div className="text-[24px] font-medium text-[var(--text-primary)] leading-none">{value}</div>
    </div>
  )
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`px-2.5 py-1 rounded-md transition-colors focus-ring ${
        active
          ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-strong)]'
          : 'border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}>
      {children}
    </button>
  )
}

function formatAgo(ms: number | null): string {
  if (ms === null) return 'pending'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function TeamCard({ team }: { team: TeamStatus }) {
  const overall: 'healthy' | 'stale' | 'pending' =
    team.crons.some(c => c.health === 'stale')   ? 'stale'
  : team.crons.every(c => c.health === 'pending') ? 'pending'
  : 'healthy'
  const dot = overall === 'healthy' ? 'bg-[var(--accent-healthy)]'
            : overall === 'stale'   ? 'bg-[var(--accent-critical)]'
                                    : 'bg-[var(--text-muted)]'
  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
        <h3 className="text-[12px] font-medium text-[var(--text-primary)]">{team.name}</h3>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-2">{team.charter}</p>
      <ul className="space-y-1 mb-2">
        {team.crons.map(c => {
          const tone = c.health === 'healthy' ? 'text-[var(--accent-healthy)]'
                     : c.health === 'stale'   ? 'text-[var(--accent-critical)]'
                                              : 'text-[var(--text-muted)]'
          return (
            <li key={c.eventType} className="flex items-center gap-2 text-[11px]">
              <span className={`font-mono uppercase text-[9px] ${tone}`}>{c.health}</span>
              <span className="text-[var(--text-secondary)] truncate flex-1">{c.label}</span>
              <span className="text-[var(--text-faint)] font-mono shrink-0">
                {formatAgo(c.ranAgoMs)} · every {Math.round(c.intervalMs / 60_000)}m
              </span>
            </li>
          )
        })}
      </ul>
      {team.recentErrors.length > 0 && (
        <div className="mt-2 pt-2 border-t border-[var(--border)] space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--accent-critical)] flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Recent errors
          </div>
          {team.recentErrors.slice(0, 3).map((e, i) => (
            <div key={i} className="text-[10px] font-mono text-[var(--text-muted)] truncate" title={e.message}>
              <span className="text-[var(--text-faint)]">{new Date(e.at).toLocaleTimeString()}</span>
              {' '}<span className="text-[var(--accent-critical)]">{e.task}</span>
              {' '}<span>{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: number }) {
  if (status === 0) return <span className="text-[var(--accent-critical)]">timeout</span>
  if (status >= 500) return <span className="text-[var(--accent-critical)]">{status}</span>
  if (status === 404) return <span className="text-[var(--accent-critical)]">{status}</span>
  if (status === 400) return <span className="text-[var(--accent-warning)]">{status}</span>
  if (status >= 200 && status < 300) return <span className="text-[var(--accent-healthy)]">{status}</span>
  return <span className="text-[var(--text-muted)]">{status}</span>
}
