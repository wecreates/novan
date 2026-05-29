/**
 * IssuesPage — standalone view of the unified engineering issue ledger.
 *
 * Same data as the war-room "Issues" tab, but as a top-level surface so
 * the operator can deep-link to it from /today and the pinned sidebar.
 *
 * Read-only here — transitions (diagnose, link, verify, close) happen
 * via the API directly. UI affordances for transitions are deferred
 * until we know the operator's actual workflow.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { PageHeader } from '../components/PageHeader.js'

interface Issue {
  id: string
  symptom: string
  rootCause: string | null
  status: string
  severity: string
  source: string
  affectedSystems: string[]
  proposalId: string | null
  patchId: string | null
  commitSha: string | null
  detectedAt: number
  updatedAt: number
  evidence: Array<{ type: string; ref: string; summary: string; at: number }>
}

const STATUS_COLORS: Record<string, string> = {
  open:        '#f43f5e',
  triaged:     '#f59e0b',
  diagnosed:   '#6366f1',
  patched:     '#a78bfa',
  verified:    '#10b981',
  closed:      '#64748b',
  rejected:    '#475569',
}
const SEV_COLORS: Record<string, string> = {
  emergency: '#f43f5e', critical: '#f43f5e', warning: '#f59e0b', info: '#6366f1',
}

export default function IssuesPage() {
  const { workspaceId } = useWorkspace()
  const qc = useQueryClient()
  const [statusFilter, setStatusFilter] = useState<string>('')

  const list = useQuery({
    queryKey: ['issues', workspaceId, statusFilter],
    queryFn:  () => api.get<{ data: Issue[] }>(
      `/api/v1/issues?workspace_id=${workspaceId}${statusFilter ? `&status=${statusFilter}` : ''}&limit=100`,
    ).then(r => r.data),
    refetchInterval: 20_000,
  })

  const stats = useQuery({
    queryKey: ['issue-stats', workspaceId],
    queryFn:  () => api.get<{ data: Array<{ status: string; severity: string; count: number }> }>(
      `/api/v1/issues/stats?workspace_id=${workspaceId}`,
    ).then(r => r.data),
    refetchInterval: 30_000,
  })

  const autoLoop = useMutation({
    mutationFn: () => api.post(`/api/v1/issues/auto-loop`, { workspace_id: workspaceId }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['issues', workspaceId] })
      qc.invalidateQueries({ queryKey: ['issue-stats', workspaceId] })
    },
  })

  const issues = list.data ?? []
  const totalByStatus: Record<string, number> = {}
  for (const s of stats.data ?? []) {
    totalByStatus[s.status] = (totalByStatus[s.status] ?? 0) + s.count
  }
  const grandTotal = Object.values(totalByStatus).reduce((a, b) => a + b, 0)

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        breadcrumb="Brain · Issues"
        title="Issue ledger"
        subtitle="Unified record from symptom → diagnosis → proposed fix → patch → verified. Every transition is auditable."
        actions={
          <button onClick={() => autoLoop.mutate()} disabled={autoLoop.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--accent-active)]/15 border border-[var(--accent-active)]/40 hover:bg-[var(--accent-active)]/25 text-[12px] text-[var(--accent-active)] focus-ring disabled:opacity-40">
            <RefreshCw className={`w-3.5 h-3.5 ${autoLoop.isPending ? 'animate-spin' : ''}`} /> Auto-loop now
          </button>
        }
      />

      {/* Status filter pills */}
      <div className="flex gap-1.5 mb-4 flex-wrap text-[11px]">
        <FilterPill active={statusFilter === ''} onClick={() => setStatusFilter('')}>
          all <span className="text-[var(--text-muted)] ml-1">{grandTotal}</span>
        </FilterPill>
        {['open','triaged','diagnosed','patched','verified','closed','rejected'].map(s => {
          const color = STATUS_COLORS[s]
          return (
            <FilterPill key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} {...(color ? { color } : {})}>
              {s} <span className="text-[var(--text-muted)] ml-1">{totalByStatus[s] ?? 0}</span>
            </FilterPill>
          )
        })}
      </div>

      {issues.length === 0 && (
        <div className="panel p-8 text-center">
          <AlertTriangle className="w-8 h-8 mb-2 mx-auto opacity-40 text-[var(--text-muted)]" />
          <div className="text-[12px] text-[var(--text-muted)]">
            {statusFilter ? `No issues in '${statusFilter}'.` : 'No issues yet — auto-ingest runs every 5 min from cron errors and incidents.'}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {issues.map(i => (
          <div key={i.id} className="panel p-3">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold"
                style={{ background: `${STATUS_COLORS[i.status] ?? '#64748b'}22`, color: STATUS_COLORS[i.status] ?? 'var(--text-muted)' }}>
                {i.status}
              </span>
              <span className="text-[9px] uppercase tracking-wider"
                style={{ color: SEV_COLORS[i.severity] ?? 'var(--text-muted)' }}>
                {i.severity}
              </span>
              <span className="text-[9px] text-[var(--text-faint)]">{i.source}</span>
              <span className="text-[10px] text-[var(--text-faint)] ml-auto">{new Date(i.detectedAt).toLocaleString()}</span>
            </div>
            <div className="text-[13px] text-[var(--text-primary)] mb-1">{i.symptom}</div>
            {i.rootCause && (
              <div className="text-[11px] text-[var(--text-muted)] mb-1">
                <span className="text-[var(--text-faint)]">root cause:</span> {i.rootCause}
              </div>
            )}
            {(i.affectedSystems?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {i.affectedSystems.map(s =>
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">{s}</span>
                )}
              </div>
            )}
            <div className="flex items-center gap-3 mt-2 text-[10px] text-[var(--text-muted)]">
              {i.proposalId && <span>proposal: <code className="text-[var(--text-secondary)]">{i.proposalId.slice(0, 8)}</code></span>}
              {i.patchId    && <span>patch: <code className="text-[var(--text-secondary)]">{i.patchId.slice(0, 8)}</code></span>}
              {i.commitSha  && <span>commit: <code className="text-[var(--text-secondary)]">{i.commitSha.slice(0, 8)}</code></span>}
              <span className="ml-auto">{i.evidence?.length ?? 0} evidence</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FilterPill({ active, onClick, color, children }: {
  active: boolean; onClick: () => void; color?: string; children: React.ReactNode
}) {
  const c = color ?? 'var(--text-muted)'
  return (
    <button onClick={onClick}
      className="px-2.5 py-1 rounded-md focus-ring"
      style={{
        background: active ? `${c}22` : 'transparent',
        border: `1px solid ${active ? c : 'var(--border)'}`,
        color: active ? c : 'var(--text-secondary)',
      }}>
      {children}
    </button>
  )
}
