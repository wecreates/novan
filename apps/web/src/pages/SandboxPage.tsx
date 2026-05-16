/**
 * SandboxPage — Strategic War Room Sandbox View.
 *
 * Shows:
 * - Active sandboxes with timeout countdown
 * - Command status + worker owner
 * - Redacted logs (never raw secrets)
 * - Failed isolation checks
 * - Sandbox event timeline per session
 */
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Terminal, ShieldAlert, Clock, CheckCircle2, XCircle,
  AlertTriangle, RefreshCcw, ChevronDown, ChevronUp,
  Lock, Activity, Eye, EyeOff,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── API ──────────────────────────────────────────────────────────────────────

const API = (path: string) => `/api/v1/sandbox${path}`

async function fetchSessions(workspaceId: string, status?: string) {
  const p = new URLSearchParams({ workspace_id: workspaceId })
  if (status) p.set('status', status)
  const r = await fetch(`${API('/sessions')}?${p}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as SandboxSession[]
}

async function fetchSessionEvents(sessionId: string) {
  const r = await fetch(API(`/sessions/${sessionId}/events`))
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as SandboxEvent[]
}

async function fetchStats(workspaceId: string) {
  const r = await fetch(`${API('/stats')}?workspace_id=${workspaceId}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as SandboxStats
}

async function cancelSession(sessionId: string) {
  const r = await fetch(API(`/sessions/${sessionId}/cancel`), { method: 'POST' })
  if (!r.ok) throw new Error((await r.json()).error ?? r.statusText)
  return r.json()
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SandboxSession {
  id:             string
  workspaceId:    string
  jobId:          string | null
  leaseOwner:     string
  command:        string
  args:           string[]
  workingDir:     string
  status:         string
  exitCode:       number | null
  durationMs:     number | null
  timeoutMs:      number
  startedAt:      number
  completedAt:    number | null
  stdoutRedacted: string
  stderrRedacted: string
  secretsRedacted: number
  violationReason: string | null
  timeoutRemainingMs: number | null
  isLeaseExpired: boolean
}

interface SandboxEvent {
  id:          string
  sessionId:   string
  eventType:   string
  leaseOwner:  string
  payload:     Record<string, unknown>
  createdAt:   number
}

interface SandboxStats {
  total:                number
  active:               number
  complete:             number
  failed:               number
  timeout:              number
  isolationViolations:  number
  totalSecretsRedacted: number
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  running:             'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  complete:            'bg-green-500/20 text-green-400 border border-green-500/30',
  failed:              'bg-red-500/20 text-red-400 border border-red-500/30',
  timeout:             'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  cancelled:           'bg-gray-500/20 text-gray-400 border border-gray-500/30',
  isolation_violation: 'bg-red-600/25 text-red-300 border border-red-600/40',
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  running:             <Activity className="w-3 h-3 animate-pulse" />,
  complete:            <CheckCircle2 className="w-3 h-3" />,
  failed:              <XCircle className="w-3 h-3" />,
  timeout:             <Clock className="w-3 h-3" />,
  cancelled:           <XCircle className="w-3 h-3" />,
  isolation_violation: <ShieldAlert className="w-3 h-3" />,
}

const EVENT_COLORS: Record<string, string> = {
  started:             'text-blue-400',
  command_executed:    'text-green-400',
  heartbeat:           'text-[var(--text-muted)]',
  timeout:             'text-orange-400',
  failed:              'text-red-400',
  completed:           'text-green-400',
  secret_redacted:     'text-yellow-400',
  isolation_violation: 'text-red-300',
  cancelled:           'text-gray-400',
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ─── Countdown timer ──────────────────────────────────────────────────────────

function TimeoutCountdown({ remainingMs }: { remainingMs: number }) {
  const [ms, setMs] = useState(remainingMs)
  useEffect(() => {
    if (ms <= 0) return
    const t = setInterval(() => setMs((p) => Math.max(0, p - 1000)), 1000)
    return () => clearInterval(t)
  }, [ms])

  const pct = Math.min(100, (remainingMs <= 0 ? 0 : (ms / remainingMs)) * 100)
  const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-yellow-500' : 'bg-red-500'

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all duration-1000`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-[var(--text-muted)]">{fmtMs(ms)}</span>
    </div>
  )
}

// ─── Session event list ───────────────────────────────────────────────────────

function SessionEvents({ sessionId }: { sessionId: string }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey:  ['sandbox-events', sessionId],
    queryFn:   () => fetchSessionEvents(sessionId),
    refetchInterval: 5000,
  })

  if (isLoading) return <p className="text-xs text-[var(--text-muted)] py-2">Loading events…</p>
  if (events.length === 0) return <p className="text-xs text-[var(--text-muted)] py-2">No events recorded</p>

  return (
    <div className="space-y-0.5 max-h-48 overflow-y-auto">
      {events.map((ev) => (
        <div key={ev.id} className="flex items-start gap-2 text-xs">
          <span className="text-[var(--text-muted)] font-mono shrink-0">{fmtTime(ev.createdAt)}</span>
          <span className={`shrink-0 font-medium ${EVENT_COLORS[ev.eventType] ?? 'text-[var(--text-secondary)]'}`}>
            {ev.eventType}
          </span>
          {ev.eventType === 'secret_redacted' && (
            <span className="text-yellow-400">
              {(ev.payload['count'] as number) ?? 0} token(s) scrubbed — patterns: {String(ev.payload['patterns'] ?? '')}
            </span>
          )}
          {ev.eventType === 'isolation_violation' && (
            <span className="text-red-300">{String(ev.payload['reason'] ?? '')}</span>
          )}
          {ev.eventType === 'command_executed' && (
            <span className="text-[var(--text-muted)]">
              exit {String(ev.payload['exitCode'] ?? '?')} · {fmtMs((ev.payload['durationMs'] as number) ?? 0)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Session card ─────────────────────────────────────────────────────────────

function SessionCard({ session }: { session: SandboxSession }) {
  const [expanded, setExpanded]   = useState(false)
  const [showLogs, setShowLogs]   = useState(false)
  const qc = useQueryClient()

  const cancelMut = useMutation({
    mutationFn: () => cancelSession(session.id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['sandbox-sessions'] }),
  })

  const cmdDisplay = [session.command, ...session.args.slice(0, 4)].join(' ')
    + (session.args.length > 4 ? ' …' : '')

  return (
    <div className={`rounded-lg border bg-[var(--bg-surface)] overflow-hidden ${
      session.status === 'isolation_violation'
        ? 'border-red-500/40'
        : session.isLeaseExpired
        ? 'border-orange-500/30'
        : 'border-[var(--border)]'
    }`}>
      {/* Header row */}
      <div className="px-4 py-3 flex items-center gap-3">
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[session.status] ?? ''}`}>
          {STATUS_ICONS[session.status]}
          <span className="capitalize">{session.status.replace('_', ' ')}</span>
        </span>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-[var(--text-primary)] truncate">{cmdDisplay}</p>
          <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">
            Worker: <span className="font-mono">{session.leaseOwner}</span>
            {session.jobId && <> · job <span className="font-mono">{session.jobId.slice(0, 8)}</span></>}
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {session.secretsRedacted > 0 && (
            <span className="flex items-center gap-1 text-xs text-yellow-400" title={`${session.secretsRedacted} secret(s) redacted`}>
              <Lock className="w-3 h-3" />
              {session.secretsRedacted}
            </span>
          )}
          {session.status === 'running' && session.timeoutRemainingMs !== null && (
            <TimeoutCountdown remainingMs={session.timeoutRemainingMs} />
          )}
          {session.durationMs !== null && session.status !== 'running' && (
            <span className="text-xs font-mono text-[var(--text-muted)]">{fmtMs(session.durationMs)}</span>
          )}
          {session.status === 'running' && (
            <button
              onClick={() => cancelMut.mutate()}
              disabled={cancelMut.isPending}
              className="text-xs px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Isolation violation banner */}
      {session.violationReason && (
        <div className="flex items-start gap-2 px-4 py-2 bg-red-500/10 border-t border-red-500/20">
          <ShieldAlert className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">{session.violationReason}</p>
        </div>
      )}

      {/* Expired lease warning */}
      {session.isLeaseExpired && session.status === 'running' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-t border-orange-500/20">
          <AlertTriangle className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <p className="text-xs text-orange-400">Lease expired — worker may have crashed</p>
        </div>
      )}

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-4">
          {/* Working dir */}
          <div>
            <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Working Directory</p>
            <p className="text-xs font-mono text-[var(--text-secondary)]">{session.workingDir}</p>
          </div>

          {/* Logs */}
          {(session.stdoutRedacted || session.stderrRedacted) && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">
                  Output (redacted)
                </p>
                {session.secretsRedacted > 0 && (
                  <span className="flex items-center gap-1 text-xs text-yellow-400">
                    <Lock className="w-3 h-3" />
                    {session.secretsRedacted} secret(s) scrubbed
                  </span>
                )}
                <button
                  onClick={() => setShowLogs((p) => !p)}
                  className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  {showLogs ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              {showLogs && (
                <pre className="text-xs font-mono bg-[var(--bg-primary)] rounded p-2 overflow-x-auto max-h-40 text-[var(--text-secondary)] whitespace-pre-wrap">
                  {(session.stdoutRedacted || session.stderrRedacted || '(empty)').slice(0, 3000)}
                </pre>
              )}
            </div>
          )}

          {/* Events */}
          <div>
            <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-2">Event Log</p>
            <SessionEvents sessionId={session.id} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Stats cards ──────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-[var(--text-primary)]'}`}>{value}</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { value: undefined, label: 'All' },
  { value: 'running', label: 'Active' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' },
  { value: 'isolation_violation', label: 'Violations' },
] as const

export default function SandboxPage() {
  const { workspaceId } = useWorkspace()
  const [filter, setFilter] = useState<string | undefined>('running')
  const qc = useQueryClient()

  const { data: sessions = [], isLoading } = useQuery({
    queryKey:    ['sandbox-sessions', workspaceId, filter],
    queryFn:     () => fetchSessions(workspaceId, filter),
    enabled:     !!workspaceId,
    refetchInterval: 5_000,
  })

  const { data: stats } = useQuery({
    queryKey:  ['sandbox-stats', workspaceId],
    queryFn:   () => fetchStats(workspaceId),
    enabled:   !!workspaceId,
    refetchInterval: 10_000,
  })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Execution Sandbox</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Isolated job execution · secret-safe · worker-leased
            </p>
          </div>
          <button
            onClick={() => {
              qc.invalidateQueries({ queryKey: ['sandbox-sessions'] })
              qc.invalidateQueries({ queryKey: ['sandbox-stats'] })
            }}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            title="Refresh"
          >
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>

        {/* Stats row */}
        {stats && (
          <div className="grid grid-cols-6 gap-2 mt-4">
            <StatCard label="Active" value={stats.active} color="text-blue-400" />
            <StatCard label="Complete" value={stats.complete} color="text-green-400" />
            <StatCard label="Failed" value={stats.failed} color="text-red-400" />
            <StatCard label="Timeout" value={stats.timeout} color="text-orange-400" />
            <StatCard label="Violations" value={stats.isolationViolations} color="text-red-300" />
            <StatCard label="Secrets Redacted" value={stats.totalSecretsRedacted} color="text-yellow-400" />
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-1 mt-3">
          {FILTER_TABS.map((t) => (
            <button
              key={t.value ?? 'all'}
              onClick={() => setFilter(t.value)}
              className={`px-3 py-1 rounded text-xs transition-colors ${
                filter === t.value
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">
            Loading sessions…
          </div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-[var(--text-muted)]">
            <Terminal className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No sandbox sessions found</p>
            <p className="text-xs mt-1 opacity-60">
              {filter === 'running'
                ? 'No active executions — all quiet'
                : 'No records match this filter'}
            </p>
          </div>
        )}

        {!isLoading && sessions.length > 0 && (
          <div className="space-y-3 max-w-4xl">
            {/* Violation banner if any */}
            {sessions.some((s) => s.status === 'isolation_violation') && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
                <p className="text-sm text-red-300">
                  Isolation violations detected — review blocked executions below
                </p>
              </div>
            )}
            {sessions.map((s) => (
              <SessionCard key={s.id} session={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
