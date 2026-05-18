/**
 * Search — semantic search over the platform's own reasoning chains.
 */
import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Search as SearchIcon } from 'lucide-react'
import { api } from '../api.js'
import { useWorkspace } from '../contexts/WorkspaceContext.js'

interface Result {
  chainId: string; score: number; decision: string; kind: string
  createdAt: number; outcomeMatched: boolean | null
}

export default function SearchPage() {
  const { workspaceId } = useWorkspace()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Result[]>([])

  const search = useMutation({
    mutationFn: (query: string) => api.get<{ data: Result[] }>(`/api/v1/self/search/chains?workspace_id=${workspaceId}&q=${encodeURIComponent(query)}&limit=30`),
    onSuccess: (r) => setResults((r as { data: Result[] }).data ?? []),
  })

  const backfill = useMutation({
    mutationFn: () => api.post(`/api/v1/self/search/backfill`, { workspace_id: workspaceId, days: 90 }),
  })

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <SearchIcon className="w-5 h-5 text-sky-400" />
        <h1 className="text-xl font-semibold">Search reasoning chains</h1>
        <span className="text-xs text-[var(--text-muted)] ml-1">hash-bag · 256 dim · zero LLM cost</span>
        <button onClick={() => backfill.mutate()} disabled={backfill.isPending}
          className="ml-auto px-2 py-1 text-xs rounded border border-[var(--border)] hover:bg-[var(--surface-hover)]">
          {backfill.isPending ? 'Indexing…' : 'Backfill 90d'}
        </button>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) search.mutate(q.trim()) }}
        className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. provider migration, drift on forecasts, capability gaps"
          className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-3 py-2 text-sm"
        />
        <button type="submit" disabled={search.isPending || !q.trim()}
          className="px-4 py-2 text-sm rounded bg-sky-500/20 border border-sky-500/40 hover:bg-sky-500/30 disabled:opacity-50">
          {search.isPending ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        {results.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[var(--text-muted)] text-center">
            {search.isSuccess ? 'No matches. Try broader terms or run backfill if chains are recent.' : 'Enter a query to search.'}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {results.map(r => (
              <li key={r.chainId} className="px-4 py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-[var(--text-muted)] w-12">{r.score.toFixed(3)}</span>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] w-24">{r.kind}</span>
                  <span className="flex-1">{r.decision}</span>
                  {r.outcomeMatched !== null && (
                    <span className={`text-[10px] ${r.outcomeMatched ? 'text-emerald-400' : 'text-red-400'}`}>
                      {r.outcomeMatched ? 'matched' : 'unmatched'}
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--text-muted)] font-mono">{new Date(r.createdAt).toLocaleDateString()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
