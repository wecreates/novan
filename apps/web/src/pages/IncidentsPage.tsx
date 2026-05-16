/**
 * IncidentsPage — Production Incident Response Console.
 *
 * Shows:
 * - Active incidents with severity + signal counts
 * - Affected systems
 * - Recommended action + assigned agent
 * - Acknowledge / Resolve / Escalate actions
 * - Per-incident timeline
 */
import { useState }          from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Siren, AlertOctagon, AlertTriangle, Info, CheckCircle2,
  Shield, ShieldAlert, ChevronDown, ChevronUp, RefreshCcw,
  Activity, Zap, Clock, ArrowUpRight, Wrench,
} from 'lucide-react'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

// ─── API ──────────────────────────────────────────────────────────────────────

const API = (p: string) => `/api/v1/incidents${p}`

async function fetchIncidents(workspaceId: string, status?: string) {
  const q = new URLSearchParams({ workspace_id: workspaceId })
  if (status) q.set('status', status)
  const r = await fetch(`${API('/')}?${q}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as Incident[]
}

async function fetchStats(workspaceId: string) {
  const r = await fetch(`${API('/stats')}?workspace_id=${workspaceId}`)
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as Stats
}

async function fetchTimeline(id: string) {
  const r = await fetch(API(`/${id}/timeline`))
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data as TimelineEntry[]
}

async function scanIncidents(workspaceId: string) {
  const r = await fetch(API('/scan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId }),
  })
  if (!r.ok) throw new Error(await r.text())
  return (await r.json()).data
}

async function postAction(id: string, action: string, body: object) {
  const r = await fetch(API(`/${id}/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }))
    throw new Error(err.error ?? r.statusText)
  }
  return r.json()
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Incident {
  id:                string
  workspaceId:       string
  type:              string
  severity:          'info' | 'warning' | 'critical' | 'emergency'
  status:            'open' | 'acknowledged' | 'mitigating' | 'resolved' | 'escalated'
  title:             string
  summary:           string
  rootCauseHypothesis: string | null
  affectedSystems:   Record<string, unknown>
  linkedEventIds:    string[]
  signalCount:       number
  recommendedAction: string | null
  assignedAgent:     string | null
  repairTaskId:      string | null
  requiresApproval:  boolean
  acknowledgedBy:    string | null
  acknowledgedAt:    number | null
  resolvedBy:        string | null
  resolvedAt:        number | null
  resolutionNote:    string | null
  escalatedAt:       number | null
  escalationReason:  string | null
  detectedAt:        number
  createdAt:         number
  updatedAt:         number
}

interface TimelineEntry {
  id:         string
  actionType: string
  actor:      string
  note:       string | null
  payload:    Record<string, unknown>
  createdAt:  number
}

interface Stats {
  total:        number
  open:         number
  acknowledged: number
  mitigating:   number
  resolved:     number
  escalated:    number
  emergency:    number
  critical:     number
}

// ─── Visual maps ──────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  emergency: 'bg-red-600/25 text-red-300 border border-red-600/40',
  critical:  'bg-red-500/20 text-red-400 border border-red-500/30',
  warning:   'bg-orange-500/20 text-orange-400 border border-orange-500/30',
  info:      'bg-blue-500/20 text-blue-400 border border-blue-500/30',
}

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  emergency: <Siren className="w-3 h-3" />,
  critical:  <AlertOctagon className="w-3 h-3" />,
  warning:   <AlertTriangle className="w-3 h-3" />,
  info:      <Info className="w-3 h-3" />,
}

const STATUS_COLORS: Record<string, string> = {
  open:         'bg-yellow-500/20 text-yellow-400',
  acknowledged: 'bg-blue-500/20 text-blue-400',
  mitigating:   'bg-purple-500/20 text-purple-400',
  resolved:     'bg-green-500/20 text-green-400',
  escalated:    'bg-red-500/25 text-red-300',
}

const TYPE_LABELS: Record<string, string> = {
  failed_workflow_spike:    'Workflow Spike',
  provider_outage:          'Provider Outage',
  worker_heartbeat_failure: 'Worker Heartbeat',
  queue_backlog:            'Queue Backlog',
  budget_burn:              'Budget Burn',
  replay_divergence:        'Replay Divergence',
  rollback_failure:         'Rollback Failure',
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

const ACTION_COLORS: Record<string, string> = {
  opened:               'text-yellow-400',
  updated:              'text-blue-400',
  triage_completed:     'text-purple-400',
  acknowledged:         'text-blue-400',
  escalated:            'text-red-300',
  resolved:             'text-green-400',
  repair_task_created:  'text-purple-400',
  mitigation_started:   'text-blue-400',
}

function IncidentTimeline({ id }: { id: string }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['incident-timeline', id],
    queryFn:  () => fetchTimeline(id),
  })

  if (isLoading) return <p className="text-xs text-[var(--text-muted)] py-2">Loading timeline…</p>
  if (events.length === 0) return <p className="text-xs text-[var(--text-muted)] py-2">No timeline entries</p>

  return (
    <div className="space-y-1.5 max-h-48 overflow-y-auto">
      {events.map((e) => (
        <div key={e.id} className="flex items-start gap-2 text-xs">
          <span className="text-[var(--text-muted)] font-mono shrink-0">{fmtTime(e.createdAt)}</span>
          <span className={`shrink-0 font-medium ${ACTION_COLORS[e.actionType] ?? 'text-[var(--text-secondary)]'}`}>
            {e.actionType.replace(/_/g, ' ')}
          </span>
          <span className="text-[var(--text-muted)]">by {e.actor}</span>
          {e.note && <span className="text-[var(--text-secondary)] truncate">— {e.note}</span>}
        </div>
      ))}
    </div>
  )
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function IncidentCard({ incident }: { incident: Incident }) {
  const [expanded, setExpanded]   = useState(false)
  const [action, setAction]       = useState<'ack' | 'resolve' | 'escalate' | null>(null)
  const [note, setNote]           = useState('')
  const [error, setError]         = useState<string | null>(null)
  const qc = useQueryClient()

  const mut = useMutation({
    mutationFn: async ({ a, n }: { a: string; n: string }) => {
      const body: Record<string, string> = { actor: 'ops-user' }
      if (a === 'resolve') body['note'] = n
      else if (a === 'escalate') body['reason'] = n
      else if (n) body['note'] = n
      if ((a === 'resolve' || a === 'escalate') && !n.trim()) {
        throw new Error(`${a} requires a note`)
      }
      return postAction(incident.id, a, body)
    },
    onSuccess: () => {
      setAction(null); setNote(''); setError(null)
      qc.invalidateQueries({ queryKey: ['incidents'] })
      qc.invalidateQueries({ queryKey: ['incident-stats'] })
      qc.invalidateQueries({ queryKey: ['incident-timeline', incident.id] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const sysList = Object.entries(incident.affectedSystems).slice(0, 4)
  const isActive = incident.status !== 'resolved'

  return (
    <div className={`rounded-lg border bg-[var(--bg-surface)] overflow-hidden ${
      incident.severity === 'emergency'
        ? 'border-red-600/40'
        : incident.severity === 'critical'
        ? 'border-red-500/30'
        : 'border-[var(--border)]'
    }`}>
      {/* Header */}
      <div className="px-4 py-3 flex items-start gap-3">
        <span className={`mt-0.5 flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${SEVERITY_COLORS[incident.severity] ?? ''}`}>
          {SEVERITY_ICONS[incident.severity]}
          <span className="capitalize">{incident.severity}</span>
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate">{incident.title}</p>
            {incident.requiresApproval && (
              <Shield className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-[var(--text-muted)]">{TYPE_LABELS[incident.type] ?? incident.type}</span>
            <span className="text-xs text-[var(--text-muted)]">·</span>
            <span className="text-xs text-[var(--text-muted)]">{incident.signalCount} signal(s)</span>
            <span className="text-xs text-[var(--text-muted)]">·</span>
            <span className="text-xs text-[var(--text-muted)]">{fmtAgo(incident.detectedAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className={`px-2 py-0.5 rounded text-xs capitalize ${STATUS_COLORS[incident.status] ?? ''}`}>
            {incident.status}
          </span>
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Affected systems chips */}
      {sysList.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1">
          {sysList.map(([k, v]) => (
            <span key={k} className="px-1.5 py-0.5 rounded text-xs bg-[var(--bg-elevated)] text-[var(--text-muted)] font-mono">
              {k}: {String(v).slice(0, 30)}
            </span>
          ))}
        </div>
      )}

      {/* Expanded */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
          <div>
            <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Summary</p>
            <p className="text-sm text-[var(--text-secondary)]">{incident.summary}</p>
          </div>

          {incident.rootCauseHypothesis && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Root Cause Hypothesis</p>
              <p className="text-sm text-[var(--text-secondary)]">{incident.rootCauseHypothesis}</p>
            </div>
          )}

          {incident.recommendedAction && (
            <div className="flex items-start gap-2 p-2 rounded bg-purple-500/10 border border-purple-500/20">
              <Wrench className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-purple-400 font-medium">Recommended Action</p>
                <p className="text-sm text-[var(--text-secondary)] mt-0.5">{incident.recommendedAction}</p>
                {incident.assignedAgent && (
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    Assigned: <span className="font-mono">{incident.assignedAgent}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {incident.resolutionNote && (
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-1">Resolution Note</p>
              <p className="text-sm text-[var(--text-secondary)] italic">{incident.resolutionNote}</p>
            </div>
          )}

          {incident.escalationReason && (
            <div className="flex items-start gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
              <ShieldAlert className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{incident.escalationReason}</p>
            </div>
          )}

          {/* Actions */}
          {isActive && (
            <div className="space-y-2">
              {action === null ? (
                <div className="flex gap-2 pt-1 flex-wrap">
                  {incident.status === 'open' && (
                    <button
                      onClick={() => setAction('ack')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors"
                    >
                      <CheckCircle2 className="w-3 h-3" /> Acknowledge
                    </button>
                  )}
                  <button
                    onClick={() => setAction('resolve')}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30 transition-colors"
                  >
                    <CheckCircle2 className="w-3 h-3" /> Resolve
                  </button>
                  {incident.status !== 'escalated' && (
                    <button
                      onClick={() => setAction('escalate')}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 transition-colors"
                    >
                      <ArrowUpRight className="w-3 h-3" /> Escalate
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2 pt-1">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {action === 'ack' ? 'Add optional note:'
                      : action === 'resolve' ? 'Resolution note (required):'
                      : 'Escalation reason (required):'}
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder={action === 'ack' ? 'Optional…' : 'Required…'}
                    className="w-full text-xs rounded border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-primary)] px-2 py-1.5 resize-none outline-none focus:border-blue-500/50"
                  />
                  {error && <p className="text-xs text-red-400">{error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        const a = action === 'ack' ? 'acknowledge' : action ?? ''
                        mut.mutate({ a, n: note })
                      }}
                      disabled={mut.isPending}
                      className="px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors disabled:opacity-50"
                    >
                      {mut.isPending ? 'Submitting…' : 'Confirm'}
                    </button>
                    <button
                      onClick={() => { setAction(null); setNote(''); setError(null) }}
                      className="px-3 py-1.5 rounded text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Timeline */}
          <div>
            <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-2">Timeline</p>
            <IncidentTimeline id={incident.id} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color, icon }: { label: string; value: number; color?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] px-4 py-3">
      <div className="flex items-center gap-1.5">
        {icon}
        <p className="text-xs text-[var(--text-muted)]">{label}</p>
      </div>
      <p className={`text-2xl font-semibold mt-1 ${color ?? 'text-[var(--text-primary)]'}`}>{value}</p>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const FILTER_TABS = [
  { value: undefined, label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'mitigating', label: 'Mitigating' },
  { value: 'escalated', label: 'Escalated' },
  { value: 'resolved', label: 'Resolved' },
] as const

export default function IncidentsPage() {
  const { workspaceId } = useWorkspace()
  const [filter, setFilter] = useState<string | undefined>('open')
  const qc = useQueryClient()

  const { data: incidents = [], isLoading } = useQuery({
    queryKey:    ['incidents', workspaceId, filter],
    queryFn:     () => fetchIncidents(workspaceId, filter),
    enabled:     !!workspaceId,
    refetchInterval: 15_000,
  })

  const { data: stats } = useQuery({
    queryKey:  ['incident-stats', workspaceId],
    queryFn:   () => fetchStats(workspaceId),
    enabled:   !!workspaceId,
    refetchInterval: 30_000,
  })

  const scanMut = useMutation({
    mutationFn: () => scanIncidents(workspaceId),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['incidents'] })
      qc.invalidateQueries({ queryKey: ['incident-stats'] })
    },
  })

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-4 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Incident Response</h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Auto-triage queue · backed by real runtime signals
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => scanMut.mutate()}
              disabled={scanMut.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border border-blue-500/30 transition-colors disabled:opacity-50"
            >
              <Zap className="w-3 h-3" />
              {scanMut.isPending ? 'Scanning…' : 'Scan Now'}
            </button>
            <button
              onClick={() => {
                qc.invalidateQueries({ queryKey: ['incidents'] })
                qc.invalidateQueries({ queryKey: ['incident-stats'] })
              }}
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
              title="Refresh"
            >
              <RefreshCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {scanMut.data && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded bg-blue-500/10 border border-blue-500/20 text-xs text-blue-300">
            <Activity className="w-3.5 h-3.5" />
            Scan complete — {(scanMut.data as { scanned: number; opened: number; updated: number }).opened} new, {(scanMut.data as { scanned: number; opened: number; updated: number }).updated} updated
          </div>
        )}

        {stats && (
          <div className="grid grid-cols-6 gap-2 mt-4">
            <StatCard label="Open"         value={stats.open}      color="text-yellow-400" icon={<AlertTriangle className="w-3 h-3 text-yellow-400" />} />
            <StatCard label="Emergency"    value={stats.emergency} color="text-red-300"    icon={<Siren className="w-3 h-3 text-red-300" />} />
            <StatCard label="Critical"     value={stats.critical}  color="text-red-400"    icon={<AlertOctagon className="w-3 h-3 text-red-400" />} />
            <StatCard label="Mitigating"   value={stats.mitigating} color="text-purple-400" icon={<Wrench className="w-3 h-3 text-purple-400" />} />
            <StatCard label="Escalated"    value={stats.escalated} color="text-red-300"    icon={<ArrowUpRight className="w-3 h-3 text-red-300" />} />
            <StatCard label="Resolved"     value={stats.resolved}  color="text-green-400"  icon={<CheckCircle2 className="w-3 h-3 text-green-400" />} />
          </div>
        )}

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

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">Loading incidents…</div>
        )}

        {!isLoading && incidents.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-[var(--text-muted)]">
            <CheckCircle2 className="w-8 h-8 mb-2 opacity-40" />
            <p className="text-sm">No incidents</p>
            <p className="text-xs mt-1 opacity-60">
              {filter === 'open' ? 'All quiet — production is healthy' : 'No incidents match this filter'}
            </p>
            <button
              onClick={() => scanMut.mutate()}
              className="mt-3 flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Zap className="w-3 h-3" /> Run detector scan
            </button>
          </div>
        )}

        {!isLoading && incidents.length > 0 && (
          <div className="space-y-3 max-w-4xl">
            {incidents.some((i) => i.severity === 'emergency') && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-600/15 border border-red-600/40">
                <Siren className="w-4 h-4 text-red-300 shrink-0 animate-pulse" />
                <p className="text-sm text-red-300 font-medium">Emergency incidents active — immediate action required</p>
              </div>
            )}
            {incidents.map((i) => (
              <IncidentCard key={i.id} incident={i} />
            ))}
          </div>
        )}
      </div>
      <span className="hidden">{Clock.name}</span>
    </div>
  )
}
