import { useState, useEffect, useCallback } from 'react'
import { Flame, RefreshCw, StopCircle, CheckCircle, Clock, DollarSign } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

const API_PFX = '/api/v1/governor'

interface RunawayJob {
  id: string; workspaceId: string; jobId: string; jobType: string
  endpointId: string | null; providerId: string | null
  costUsd: number; durationMs: number; reason: string
  stopped: boolean; stoppedAt: number | null; detectedAt: number
}

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  cost_exceeded:      { label: 'Cost Exceeded',     color: 'text-red-400 bg-red-500/10 border-red-500/20' },
  duration_exceeded:  { label: 'Duration Exceeded', color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
  retry_exceeded:     { label: 'Retry Exceeded',    color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
  manual:             { label: 'Manual Stop',       color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleString()
}

export default function RunawayJobsPage() {
  const { workspaceId } = useWorkspace()
  const [jobs, setJobs]           = useState<RunawayJob[]>([])
  const [loading, setLoading]     = useState(true)
  const [showStopped, setShowStopped] = useState(false)
  const [stopping, setStopping]   = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = showStopped ? '?stopped=true' : ''
      const j = await api.get<{ success: boolean; data: RunawayJob[] }>(`${API_PFX}/runaway-jobs/${workspaceId}${qs}`)
      if (j.success) setJobs(j.data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [workspaceId, showStopped])

  useEffect(() => { void load() }, [load])

  const stopJob = async (id: string) => {
    setStopping((s) => ({ ...s, [id]: true }))
    try {
      await api.post(`${API_PFX}/runaway-jobs/${id}/stop`, {})
      void load()
    } finally {
      setStopping((s) => ({ ...s, [id]: false }))
    }
  }

  const active = jobs.filter((j) => !j.stopped)
  const stopped = jobs.filter((j) => j.stopped)

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Flame className="w-5 h-5 text-orange-400" />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Runaway Jobs</h1>
            <p className="text-xs text-[var(--text-muted)]">Jobs detected exceeding cost, duration, or retry limits</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={showStopped}
              onChange={(e) => setShowStopped(e.target.checked)}
              className="rounded"
            />
            Show stopped
          </label>
          <button onClick={load} className="p-1.5 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Active runaway jobs */}
      {active.length > 0 && (
        <div className="bg-orange-500/5 border border-orange-500/20 rounded-lg p-4">
          <p className="text-sm font-medium text-orange-300 mb-3">
            {active.length} active runaway job{active.length > 1 ? 's' : ''} detected
          </p>
          <div className="space-y-2">
            {active.map((job) => {
              const r = REASON_LABELS[job.reason] ?? { label: job.reason, color: 'text-[var(--text-muted)]' }
              return (
                <div key={job.id} className="bg-[var(--bg-surface)] border border-orange-500/20 rounded-lg p-4 flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono text-[var(--text-muted)]">{job.jobId.slice(0, 12)}…</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs border font-medium ${r.color}`}>{r.label}</span>
                      <span className="text-xs text-[var(--text-muted)] bg-[var(--bg-elevated)] px-1.5 py-0.5 rounded">{job.jobType}</span>
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-xs text-[var(--text-muted)]">
                      <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" />${job.costUsd.toFixed(5)}</span>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtDuration(job.durationMs)}</span>
                      <span>Detected {fmtTs(job.detectedAt)}</span>
                    </div>
                    {job.endpointId && <p className="text-xs text-[var(--text-muted)] mt-1">Endpoint: {job.endpointId}</p>}
                  </div>
                  <button
                    onClick={() => void stopJob(job.id)}
                    disabled={stopping[job.id]}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-red-500/15 text-red-400 border border-red-500/20 hover:bg-red-500/25 transition-colors"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                    Stop
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Empty active state */}
      {!loading && active.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-6 justify-center">
          <CheckCircle className="w-4 h-4 text-green-400" />
          No active runaway jobs detected
        </div>
      )}

      {/* Stopped/historical jobs */}
      {showStopped && stopped.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">History</p>
          {stopped.map((job) => {
            const r = REASON_LABELS[job.reason] ?? { label: job.reason, color: 'text-[var(--text-muted)]' }
            return (
              <div key={job.id} className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg p-4 flex items-center justify-between gap-4 opacity-70">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-[var(--text-muted)]">{job.jobId.slice(0, 12)}…</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs border ${r.color}`}>{r.label}</span>
                    <span className="text-xs text-[var(--text-muted)] bg-[var(--bg-elevated)] px-1.5 py-0.5 rounded">{job.jobType}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-[var(--text-muted)]">
                    <span>${job.costUsd.toFixed(5)}</span>
                    <span>{fmtDuration(job.durationMs)}</span>
                    {job.stoppedAt && <span>Stopped {fmtTs(job.stoppedAt)}</span>}
                  </div>
                </div>
                <CheckCircle className="w-4 h-4 text-green-400 shrink-0" />
              </div>
            )
          })}
        </div>
      )}

      {loading && (
        <div className="space-y-2">
          {[0,1,2].map((i) => <div key={i} className="h-16 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg animate-pulse" />)}
        </div>
      )}
    </div>
  )
}
