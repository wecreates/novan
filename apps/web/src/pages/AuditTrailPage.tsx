/**
 * Audit Trail — read-only timeline of system events.
 *
 * Consumes /api/v1/events with filters. Lets the operator scan in 30s
 * to see what the autonomous layers have been doing.
 */
import React, { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, Filter, RefreshCw } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface EventRow {
  id: string; type: string; workspaceId: string
  payload: Record<string, unknown> | null
  source: string; createdAt: number
}

const TYPE_COLOR: Array<{ match: RegExp; cls: string }> = [
  { match: /error|failed|critical/i, cls: 'text-red-300 bg-red-500/10' },
  { match: /drift|warning|spike/i,   cls: 'text-amber-300 bg-amber-500/10' },
  { match: /economic|cost|spend/i,   cls: 'text-emerald-300 bg-emerald-500/10' },
  { match: /cron|task/i,             cls: 'text-slate-300 bg-slate-500/10' },
  { match: /governance|approval/i,   cls: 'text-purple-300 bg-purple-500/10' },
  { match: /action|dispatch/i,       cls: 'text-sky-300 bg-sky-500/10' },
]
function typeColor(t: string): string {
  for (const r of TYPE_COLOR) if (r.match.test(t)) return r.cls
  return 'text-slate-400 bg-slate-500/5'
}

export default function AuditTrailPage() {
  const { workspaceId } = useWorkspace()
  const [filter, setFilter] = useState<string>('')
  const [limit, setLimit] = useState<number>(100)

  const events = useQuery({
    queryKey: ['events', workspaceId, filter, limit],
    queryFn:  () => api.get<{ data: EventRow[] }>(`/api/v1/events?workspace_id=${workspaceId}&limit=${limit}${filter ? `&type=${encodeURIComponent(filter)}` : ''}`),
    refetchInterval: 30_000,
  })

  const rows = events.data?.data ?? []
  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Clock className="w-5 h-5 text-sky-400" />
        <h1 className="text-xl font-semibold">Audit Trail</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">read-only · last {limit} events</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs">
            <Filter className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter type (substring)"
              className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 w-48"
            />
          </div>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-[var(--surface)] border border-[var(--border)] rounded text-xs px-2 py-1">
            {[50, 100, 250, 500].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={() => events.refetch()} className="p-1.5 rounded hover:bg-[var(--surface-hover)]">
            <RefreshCw className={`w-3.5 h-3.5 ${events.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {rows.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[var(--text-muted)] text-center">No events match.</div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {rows.map(e => (
              <li key={e.id} className="px-4 py-2 text-xs flex items-start gap-3">
                <span className="text-[var(--text-muted)] font-mono whitespace-nowrap w-28">
                  {new Date(e.createdAt).toLocaleString().replace(',', '')}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono whitespace-nowrap ${typeColor(e.type)}`}>{e.type}</span>
                <span className="font-mono text-[var(--text-muted)] whitespace-nowrap">{e.source}</span>
                <span className="text-[var(--text)] font-mono truncate flex-1" title={JSON.stringify(e.payload ?? {})}>
                  {e.payload ? JSON.stringify(e.payload).slice(0, 280) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
