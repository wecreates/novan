/**
 * AnomaliesPage — R146.19
 *
 * Wires the previously-invisible `anomaly_signals` table to a UI.
 * The brain's `anomaly-detection.scanAnomalies` cron (R146.15 batched
 * the writes) had no way to surface its findings — operator had to
 * SQL the table directly. This page lists open anomalies with their
 * kind, severity, score, evidence count + first/last seen, plus an
 * ack button and on-demand scan.
 *
 * Backend: routes/intel-ops.ts
 *   GET  /api/v1/intel-ops/anomalies
 *   POST /api/v1/intel-ops/anomalies/scan
 *   POST /api/v1/intel-ops/anomalies/:id/ack
 */
import React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertOctagon, Activity, CheckCircle2, RefreshCw } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface AnomalyRow {
  id:           string
  workspaceId:  string
  kind:         string
  severity:     'low' | 'medium' | 'high' | 'critical'
  score:        number
  subject:      string | null
  evidence:     unknown[]
  firstSeenAt:  number
  lastSeenAt:   number
  occurrences:  number
  acknowledgedAt?: number | null
}

const SEV_TONE: Record<string, string> = {
  critical: 'text-red-300 bg-red-500/15 border-red-500/40',
  high:     'text-amber-300 bg-amber-500/15 border-amber-500/40',
  medium:   'text-sky-300 bg-sky-500/15 border-sky-500/40',
  low:      'text-slate-300 bg-slate-500/15 border-slate-500/40',
}

export default function AnomaliesPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()

  const list = useQuery({
    queryKey: ['anomalies', workspaceId],
    queryFn:  () => api.get<{ data: AnomalyRow[] }>(`/api/v1/intel-ops/anomalies?workspace_id=${workspaceId}&limit=100`),
    refetchInterval: 30_000,
  })

  const scan = useMutation({
    mutationFn: () => api.post<{ data: { raised: number; updated: number } }>(`/api/v1/intel-ops/anomalies/scan`, { workspace_id: workspaceId }),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['anomalies', workspaceId] }) },
  })

  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/intel-ops/anomalies/${id}/ack`, { workspace_id: workspaceId }),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: ['anomalies', workspaceId] }) },
  })

  const rows = list.data?.data ?? []
  const open = rows.filter(r => !r.acknowledgedAt)
  const acked = rows.filter(r => r.acknowledgedAt)

  return (
    <div className="p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <AlertOctagon className="w-5 h-5 text-amber-400" />
        <h1 className="text-xl font-semibold">Anomalies</h1>
        <span className="text-xs text-muted">{open.length} open · {acked.length} acknowledged</span>
        <button
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${scan.isPending ? 'animate-spin' : ''}`} />
          {scan.isPending ? 'Scanning…' : 'Scan now'}
        </button>
      </div>

      {scan.data?.data && (
        <div className="text-xs text-muted">
          Last scan: raised {scan.data.data.raised}, updated {scan.data.data.updated}
        </div>
      )}

      {list.isLoading ? (
        <div className="text-sm text-muted">Loading…</div>
      ) : open.length === 0 ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-5 py-4 text-sm text-emerald-300">
          No open anomalies. The brain's detector hasn't flagged anything in the recent window.
        </div>
      ) : (
        <Section title={`Open (${open.length})`} icon={<Activity className="w-4 h-4 text-amber-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {open.map(a => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] border ${SEV_TONE[a.severity] ?? SEV_TONE.medium}`}>
                    {a.severity}
                  </span>
                  <span className="font-mono text-xs">{a.kind}</span>
                  {a.subject && <span className="text-xs text-muted truncate">{a.subject}</span>}
                  <span className="text-[11px] text-muted">score {a.score.toFixed(2)}</span>
                  <span className="text-[11px] text-muted">{a.occurrences}× · last {new Date(a.lastSeenAt).toLocaleTimeString()}</span>
                  <button
                    onClick={() => ack.mutate(a.id)}
                    disabled={ack.isPending}
                    className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-[11px] border border-border hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-3 h-3" /> Ack
                  </button>
                </div>
                {a.evidence.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-xs text-muted cursor-pointer hover:text-primary">{a.evidence.length} evidence item(s)</summary>
                    <pre className="mt-1 text-[10px] font-mono bg-[var(--surface-hover)] p-2 rounded overflow-x-auto">
                      {JSON.stringify(a.evidence, null, 2)}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {acked.length > 0 && (
        <Section title={`Acknowledged (${acked.length})`} icon={<CheckCircle2 className="w-4 h-4 text-emerald-400" />}>
          <ul className="divide-y divide-[var(--border)]">
            {acked.slice(0, 25).map(a => (
              <li key={a.id} className="px-4 py-2 text-xs flex items-center gap-3 text-muted">
                <span className="font-mono">{a.kind}</span>
                <span>{a.occurrences}×</span>
                <span>last {new Date(a.lastSeenAt).toLocaleTimeString()}</span>
                <span className="ml-auto">acked {a.acknowledgedAt ? new Date(a.acknowledgedAt).toLocaleString() : '?'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </div>
  )
}
