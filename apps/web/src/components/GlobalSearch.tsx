/**
 * GlobalSearch — command palette search across all entities.
 * Triggered by Cmd+K / Ctrl+K keyboard shortcut.
 */
import { useState, useEffect, useRef } from 'react'
import { useQuery }    from '@tanstack/react-query'
import { Search, X, Brain, Target, AlertTriangle, Zap, Users, Globe, FileText, TrendingUp } from 'lucide-react'
import { searchApi, type SearchHit, type SearchEntityType } from '../api.js'

const TYPE_ICON: Record<SearchEntityType, React.ReactNode> = {
  memory:      <Brain className="w-3 h-3" />,
  opportunity: <TrendingUp className="w-3 h-3" />,
  risk:        <AlertTriangle className="w-3 h-3" />,
  insight:     <Zap className="w-3 h-3" />,
  goal:        <Target className="w-3 h-3" />,
  agent:       <Users className="w-3 h-3" />,
  business:    <Globe className="w-3 h-3" />,
  workflow:    <FileText className="w-3 h-3" />,
}

const TYPE_COLOR: Record<SearchEntityType, string> = {
  memory:      'text-purple-400',
  opportunity: 'text-indigo-400',
  risk:        'text-red-400',
  insight:     'text-amber-400',
  goal:        'text-blue-400',
  agent:       'text-emerald-400',
  business:    'text-cyan-400',
  workflow:    'text-gray-400',
}

export function GlobalSearch() {
  const [open, setOpen]         = useState(false)
  const [query, setQuery]       = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn:  () => searchApi.search(query, { limit: 20 }),
    enabled:  query.length >= 2,
    staleTime: 5_000,
  })

  const hits: SearchHit[] = data?.data ?? []

  // Cmd+K / Ctrl+K to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        setQuery('')
        setSelected(0)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Focus input when opened. Track the timer so unmount-while-opening
  // doesn't fire .focus() on a torn-down ref.
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [open])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => Math.min(s + 1, hits.length - 1)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && hits[selected]) setOpen(false)
  }

  if (!open) return (
    <button
      onClick={() => setOpen(true)}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-[var(--text-muted)] border border-[var(--border)] hover:bg-[var(--bg-elevated)] transition-colors"
    >
      <Search className="w-3 h-3" />
      <span>Search</span>
      <kbd className="text-[9px] px-1 py-0.5 rounded bg-[var(--bg-elevated)] border border-[var(--border)]">⌘K</kbd>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-xl bg-[var(--bg-surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)]">
          <Search className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0) }}
            onKeyDown={handleKeyDown}
            placeholder="Search memories, opportunities, risks, goals…"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
          />
          {isFetching && (
            <div className="w-3 h-3 border border-[var(--text-muted)] border-t-transparent rounded-full animate-spin shrink-0" />
          )}
          <button onClick={() => setOpen(false)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Results */}
        {query.length >= 2 && (
          <div className="max-h-80 overflow-y-auto">
            {hits.length === 0 && !isFetching ? (
              <div className="px-4 py-6 text-sm text-[var(--text-muted)] text-center">No results for "{query}"</div>
            ) : (
              <ul>
                {hits.map((hit, i) => (
                  <li
                    key={`${hit.type}-${hit.id}`}
                    className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer transition-colors ${i === selected ? 'bg-[var(--bg-elevated)]' : 'hover:bg-[var(--bg-elevated)]'}`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => setOpen(false)}
                  >
                    <span className={`shrink-0 ${TYPE_COLOR[hit.type]}`}>{TYPE_ICON[hit.type]}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs text-[var(--text-primary)] truncate block">{hit.title}</span>
                      {hit.subtitle && <span className="text-[10px] text-[var(--text-muted)]">{hit.subtitle}</span>}
                    </div>
                    <span className="shrink-0 text-[10px] text-[var(--text-muted)] capitalize">{hit.type}</span>
                    {hit.status && <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{hit.status}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {query.length < 2 && (
          <div className="px-4 py-4 text-xs text-[var(--text-muted)]">
            Type to search across memories, opportunities, risks, insights, goals, agents, businesses, and workflows.
          </div>
        )}

        {/* Footer hints */}
        <div className="px-4 py-2 border-t border-[var(--border)] flex items-center gap-4 text-[10px] text-[var(--text-muted)]">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>Esc close</span>
          {(data?.meta.count ?? 0) > 0 && (
            <span className="ml-auto">{data!.meta.count} results</span>
          )}
        </div>
      </div>
    </div>
  )
}
