/**
 * Dead Letter Queue monitor — view, retry, and discard failed jobs.
 */
import { useState }                                      from 'react'
import { useQuery, useMutation, useQueryClient }         from '@tanstack/react-query'
import { formatDistanceToNow }                           from 'date-fns'
import { RefreshCw, CheckCircle, AlertTriangle, Inbox, RotateCcw, Trash2, ChevronDown, ChevronRight } from 'lucide-react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DlqJob {
  id:             string
  queueName:      string
  jobName:        string
  errorMessage?:  string
  payload?:       unknown
  deadLetteredAt: number
  attemptCount:   number
  replayedAt?:    number
  replayedBy?:    string
}

interface DlqStats {
  total:   number
  replayed: number
  pending: number
  byQueue: Record<string, number>
}

// ─── API ──────────────────────────────────────────────────────────────────────

const dlqApi = {
  list: (params?: { queue?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.queue) qs.set('queue', params.queue)
    qs.set('limit', String(params?.limit ?? 50))
    return fetch(`/api/v1/dead-letter?${qs.toString()}`).then((r) => r.json()) as Promise<{ success: true; data: DlqJob[] }>
  },
  stats: () =>
    fetch('/api/v1/dead-letter/stats').then((r) => r.json()) as Promise<{ success: true; data: DlqStats }>,
  retry: (id: string) =>
    fetch(`/api/v1/dead-letter/${id}/retry`, { method: 'POST' }).then((r) => r.json()) as Promise<{ success: true }>,
  discard: (id: string) =>
    fetch(`/api/v1/dead-letter/${id}/discard`, { method: 'POST' }).then((r) => r.json()) as Promise<{ success: true }>,
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUES = ['all', 'workflow', 'recovery', 'memory', 'browser', 'analytics', 'briefing', 'optimization'] as const
type QueueFilter = (typeof QUEUES)[number]

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ─── Queue Badge ──────────────────────────────────────────────────────────────

const QUEUE_COLORS: Record<string, string> = {
  workflow:     '#6366f1',
  recovery:     '#f59e0b',
  memory:       '#8b5cf6',
  browser:      '#0ea5e9',
  analytics:    '#10b981',
  briefing:     '#f43f5e',
  optimization: '#fb923c',
}

function QueueBadge({ queue }: { queue: string }) {
  const color = QUEUE_COLORS[queue] ?? '#64748b'
  return (
    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 4, background: `${color}22`, color, border: `1px solid ${color}44`, whiteSpace: 'nowrap' }}>
      {queue.toUpperCase()}
    </span>
  )
}

// ─── Job Row ──────────────────────────────────────────────────────────────────

function JobRow({ job, onRetry, onDiscard }: {
  job:       DlqJob
  onRetry:   (id: string) => void
  onDiscard: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const isReplayed  = job.replayedAt !== undefined
  const errorShort  = (job.errorMessage ?? '—').slice(0, 120)
  const errorFull   = job.errorMessage ?? '—'
  const isTruncated = errorFull.length > 120

  return (
    <>
      <tr
        onClick={() => setExpanded((e) => !e)}
        style={{ cursor: 'pointer', background: expanded ? 'var(--bg-elevated)' : undefined, borderBottom: '1px solid var(--border)' }}
      >
        {/* Expand icon */}
        <td style={{ padding: '10px 8px 10px 12px', width: 20 }}>
          {expanded
            ? <ChevronDown style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />
            : <ChevronRight style={{ width: 14, height: 14, color: 'var(--text-muted)' }} />}
        </td>
        {/* Job ID + queue */}
        <td style={{ padding: '10px 8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
              {job.id.slice(0, 12)}…
            </span>
            <QueueBadge queue={job.queueName} />
          </div>
        </td>
        {/* Job name */}
        <td style={{ padding: '10px 8px' }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{job.jobName}</span>
        </td>
        {/* Error */}
        <td style={{ padding: '10px 8px', maxWidth: 280 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
            {isTruncated && !expanded ? `${errorShort}…` : errorShort}
          </span>
        </td>
        {/* Dead-lettered at */}
        <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {formatDistanceToNow(job.deadLetteredAt, { addSuffix: true })}
          </span>
        </td>
        {/* Attempts */}
        <td style={{ padding: '10px 8px', textAlign: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{job.attemptCount}</span>
        </td>
        {/* Status */}
        <td style={{ padding: '10px 8px', whiteSpace: 'nowrap' }}>
          {isReplayed ? (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#10b981' }}>
              Replayed {formatDistanceToNow(job.replayedAt!, { addSuffix: true })}
            </span>
          ) : (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#f59e0b' }}>Pending</span>
          )}
        </td>
        {/* Actions */}
        <td style={{ padding: '10px 12px 10px 8px' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!isReplayed && (
              <button
                onClick={() => onRetry(job.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                <RotateCcw style={{ width: 11, height: 11 }} />
                Retry
              </button>
            )}
            {confirmDiscard ? (
              <>
                <button
                  onClick={() => { onDiscard(job.id); setConfirmDiscard(false) }}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#f87171', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDiscard(false)}
                  style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmDiscard(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 6, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                <Trash2 style={{ width: 11, height: 11 }} />
                Discard
              </button>
            )}
          </div>
        </td>
      </tr>
      {/* Expanded detail */}
      {expanded && (
        <tr style={{ background: 'var(--bg-elevated)' }}>
          <td colSpan={8} style={{ padding: '0 12px 14px 40px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>FULL ERROR</div>
                <pre style={{ fontSize: 11, color: '#f87171', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
                  {errorFull}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>PAYLOAD</div>
                <pre style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, maxHeight: 220, overflow: 'auto' }}>
                  {JSON.stringify(job.payload ?? null, null, 2)}
                </pre>
              </div>
              {job.replayedBy !== undefined && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Replayed by: <span style={{ color: '#10b981' }}>{job.replayedBy}</span>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DeadLetterPage() {
  const qc                        = useQueryClient()
  const [queueFilter, setQueue]   = useState<QueueFilter>('all')

  const statsQ = useQuery({
    queryKey:       ['dlq', 'stats'],
    queryFn:        () => dlqApi.stats(),
    refetchInterval: 30_000,
  })

  const jobsQ = useQuery({
    queryKey:       ['dlq', 'jobs', queueFilter],
    queryFn:        () =>
      dlqApi.list({ ...(queueFilter !== 'all' ? { queue: queueFilter } : {}) }),
    refetchInterval: 30_000,
  })

  const retryMut = useMutation({
    mutationFn: (id: string) => dlqApi.retry(id),
    onSuccess:  () => {
      void qc.invalidateQueries({ queryKey: ['dlq'] })
    },
  })

  const discardMut = useMutation({
    mutationFn: (id: string) => dlqApi.discard(id),
    onSuccess:  () => {
      void qc.invalidateQueries({ queryKey: ['dlq'] })
    },
  })

  const stats = statsQ.data?.data
  const jobs  = jobsQ.data?.data ?? []
  const pending = jobs.filter((j) => j.replayedAt === undefined)

  const retryAll = async () => {
    for (const job of pending) {
      await dlqApi.retry(job.id)
    }
    void qc.invalidateQueries({ queryKey: ['dlq'] })
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dlq'] })
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AlertTriangle style={{ width: 20, height: 20, color: '#f59e0b' }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Dead Letter Queue</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Queue filter */}
          <select
            value={queueFilter}
            onChange={(e) => setQueue(e.target.value as QueueFilter)}
            style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer' }}
          >
            {QUEUES.map((q) => (
              <option key={q} value={q}>{q === 'all' ? 'All queues' : q}</option>
            ))}
          </select>
          {/* Refresh */}
          <button
            onClick={refresh}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}
          >
            <RefreshCw style={{ width: 13, height: 13 }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats bar */}
      {stats !== undefined && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <StatCard label="Total Failed"  value={stats.total}    color="var(--text-primary)" />
          <StatCard label="Replayed"      value={stats.replayed} color="#10b981" />
          <StatCard label="Pending"       value={stats.pending}  color="#f59e0b" />
        </div>
      )}

      {/* Bulk actions */}
      {pending.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <button
            onClick={() => { void retryAll() }}
            disabled={retryMut.isPending}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: retryMut.isPending ? 0.6 : 1 }}
          >
            <RotateCcw style={{ width: 13, height: 13 }} />
            Retry All Pending ({pending.length})
          </button>
        </div>
      )}

      {/* Jobs list */}
      {jobsQ.isLoading ? (
        <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : jobs.length === 0 ? (
        /* Empty state */
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '64px 0', color: 'var(--text-muted)' }}>
          <CheckCircle style={{ width: 40, height: 40, color: '#10b981' }} />
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }}>No failed jobs</span>
          <span style={{ fontSize: 13 }}>All queues are healthy</span>
        </div>
      ) : (
        <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ width: 20 }} />
                <th style={{ padding: '8px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>JOB ID / QUEUE</th>
                <th style={{ padding: '8px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>JOB NAME</th>
                <th style={{ padding: '8px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', maxWidth: 280 }}>ERROR</th>
                <th style={{ padding: '8px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>DEAD-LETTERED</th>
                <th style={{ padding: '8px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>ATTEMPTS</th>
                <th style={{ padding: '8px 8px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>STATUS</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onRetry={(id) => retryMut.mutate(id)}
                  onDiscard={(id) => discardMut.mutate(id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Inbox icon if no stats loaded yet */}
      {!statsQ.data && !statsQ.isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, color: 'var(--text-muted)', fontSize: 12 }}>
          <Inbox style={{ width: 13, height: 13 }} />
          Stats unavailable
        </div>
      )}
    </div>
  )
}
