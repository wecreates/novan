/**
 * BrainErrorsPage — `/brain/errors`
 *
 * Surfaces every error the brain has ingested. Operator can audit
 * what's been auto-diagnosed, auto-fixed, or still open. Brain runs
 * the show; this page is the operator's read-only window into it.
 */
import { useQuery } from '@tanstack/react-query'
import { useWorkspace } from '../contexts/WorkspaceContext.js'
import { api } from '../api.js'
import { PageState } from '../components/PageState.js'
import { Brain, AlertTriangle, CheckCircle2, ClipboardList, Search } from 'lucide-react'
import { useState } from 'react'

interface BrainError {
  id:              string
  symptom:         string
  severity:        string
  status:          string
  rootCause:       string | null
  proposedFix:     string | null
  riskLevel:       string | null
  fingerprint:     string
  affectedSystems: string[]
  detectedAt:      number
  diagnosedAt:     number | null
}

const STATUS_BADGE: Record<string, string> = {
  open:      'bg-slate-500/15 text-slate-300 border-slate-500/30',
  triaged:   'bg-amber-500/15 text-amber-300 border-amber-500/30',
  diagnosed: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  patched:   'bg-violet-500/15 text-violet-300 border-violet-500/30',
  verified:  'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  closed:    'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}
const SEVERITY_BADGE: Record<string, string> = {
  info:      'bg-slate-500/15 text-slate-400',
  warning:   'bg-amber-500/15 text-amber-400',
  critical:  'bg-rose-500/15 text-rose-400',
  emergency: 'bg-rose-700/30 text-rose-300',
}

export default function BrainErrorsPage() {
  const { workspaceId } = useWorkspace()
  const [filter, setFilter] = useState('')

  const errors = useQuery({
    queryKey: ['brain-errors', workspaceId],
    queryFn: () => api.get<{ data: BrainError[] }>(`/api/v1/brain/errors?workspace_id=${workspaceId}&limit=100`),
    refetchInterval: 30_000,
  })

  if (errors.isPending) return <PageState kind="loading" label="Loading brain error log…" />
  if (errors.isError)   return <PageState kind="error" error={errors.error} onRetry={() => errors.refetch()} />

  const list = (errors.data?.data ?? []).filter(e =>
    !filter || e.symptom.toLowerCase().includes(filter.toLowerCase()) || e.rootCause?.toLowerCase().includes(filter.toLowerCase()),
  )

  const stats = {
    total:     errors.data?.data?.length ?? 0,
    diagnosed: (errors.data?.data ?? []).filter(e => e.diagnosedAt).length,
    patched:   (errors.data?.data ?? []).filter(e => e.status === 'patched' || e.status === 'verified').length,
    open:      (errors.data?.data ?? []).filter(e => e.status === 'open').length,
  }

  return (
    <div className="min-h-screen bg-bg text-primary p-6 max-w-6xl mx-auto">
      <header className="mb-6">
        <div className="flex items-center gap-3">
          <Brain className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-2xl font-semibold">Brain error log</h1>
          <span className="text-xs text-muted">
            {stats.total} total · {stats.diagnosed} diagnosed · {stats.patched} patched · {stats.open} open
          </span>
        </div>
        <p className="text-sm text-muted mt-1">
          Every error the platform produced. Brain dedupes, diagnoses, and (when low-risk + safe paths) auto-fixes — you watch.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-2">
        <Search className="w-4 h-4 text-muted" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by symptom or root cause…"
          className="flex-1 px-3 py-1.5 text-sm bg-[var(--bg-elevated)] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--border-glow)]" />
      </div>

      {list.length === 0 ? (
        <div className="border border-emerald-500/30 bg-emerald-500/5 rounded-lg p-6 text-center text-sm text-emerald-300">
          <CheckCircle2 className="w-5 h-5 inline-block mr-2" />
          {filter ? 'No errors match filter.' : 'Brain has not ingested any errors. The platform is clean.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {list.map(e => <ErrorRow key={e.id} e={e} />)}
        </ul>
      )}
    </div>
  )
}

function ErrorRow({ e }: { e: BrainError }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <li className="border border-[var(--border)] rounded p-3 bg-[var(--surface)] hover:border-[var(--text-muted)] transition-colors">
      <div className="flex items-center gap-2 cursor-pointer" onClick={() => setExpanded(v => !v)}>
        <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider ${SEVERITY_BADGE[e.severity] ?? SEVERITY_BADGE.warning}`}>{e.severity}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_BADGE[e.status] ?? STATUS_BADGE.open}`}>{e.status}</span>
        <span className="font-medium flex-1 truncate text-sm">{e.symptom}</span>
        <span className="text-[10px] text-[var(--text-faint)]">{new Date(e.detectedAt).toLocaleString()}</span>
      </div>
      {(e.rootCause || e.proposedFix) && !expanded && (
        <div className="mt-1.5 text-[11px] text-[var(--text-muted)] flex items-center gap-2">
          {e.rootCause && <><AlertTriangle className="w-3 h-3 text-[var(--warning)]" /> <span className="truncate">{e.rootCause}</span></>}
        </div>
      )}
      {expanded && (
        <div className="mt-3 space-y-2 text-xs">
          {e.rootCause && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-0.5">Root cause</div>
              <div className="text-[var(--text-primary)]">{e.rootCause}</div>
            </div>
          )}
          {e.proposedFix && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-0.5">Proposed fix</div>
              <div className="text-[var(--text-primary)]">{e.proposedFix}</div>
            </div>
          )}
          {e.affectedSystems.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-0.5">Affected</div>
              <div className="flex flex-wrap gap-1">
                {e.affectedSystems.map(s => (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] font-mono text-[var(--text-muted)]">{s}</span>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 text-[10px] text-[var(--text-faint)]">
            <span className="font-mono">fp: {e.fingerprint}</span>
            {e.riskLevel && <span>risk: {e.riskLevel}</span>}
            <ClipboardList className="w-3 h-3" />
          </div>
        </div>
      )}
    </li>
  )
}
