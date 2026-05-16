/**
 * MemoryBrowserPage — browse, search, create, and manage memory entries.
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient }     from '@tanstack/react-query'
import { format, formatDistanceToNow }               from 'date-fns'
import {
  Brain, Plus, Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  X, Tag, AlertCircle, Loader2, CheckCircle,
} from 'lucide-react'
import { warRoomApi, type Memory }                   from '../api.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_TYPES = [
  'observation', 'decision', 'lesson', 'goal', 'idea', 'fact', 'strategic', 'operational',
] as const

type MemoryType = typeof MEMORY_TYPES[number]

const TYPE_COLORS: Record<string, { badge: string; dot: string }> = {
  observation: { badge: 'bg-blue-500/15 text-blue-400 border-blue-500/25',     dot: 'bg-blue-400' },
  decision:    { badge: 'bg-amber-500/15 text-amber-400 border-amber-500/25',   dot: 'bg-amber-400' },
  lesson:      { badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25', dot: 'bg-emerald-400' },
  goal:        { badge: 'bg-violet-500/15 text-violet-400 border-violet-500/25', dot: 'bg-violet-400' },
  idea:        { badge: 'bg-pink-500/15 text-pink-400 border-pink-500/25',      dot: 'bg-pink-400' },
  fact:        { badge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',      dot: 'bg-cyan-400' },
  strategic:   { badge: 'bg-orange-500/15 text-orange-400 border-orange-500/25', dot: 'bg-orange-400' },
  operational: { badge: 'bg-teal-500/15 text-teal-400 border-teal-500/25',     dot: 'bg-teal-400' },
}

function typeStyle(type: string) {
  return TYPE_COLORS[type] ?? { badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25', dot: 'bg-zinc-400' }
}

const LIMIT = 20

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  return format(new Date(ts), 'MMM d, yyyy HH:mm')
}

function relativeTs(ts: number): string {
  return formatDistanceToNow(new Date(ts), { addSuffix: true })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  const s = typeStyle(type)
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {type}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = value >= 0.8 ? 'bg-emerald-400' : value >= 0.5 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">{value.toFixed(2)}</span>
    </div>
  )
}

function EmptyState({ search, typeFilter }: { search: string; typeFilter: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Brain className="w-10 h-10 text-[var(--text-muted)] opacity-40" />
      <p className="text-sm text-[var(--text-secondary)]">No memories found</p>
      {(search || typeFilter !== 'all') && (
        <p className="text-xs text-[var(--text-muted)]">Try clearing your filters</p>
      )}
    </div>
  )
}

// ─── Create Form ──────────────────────────────────────────────────────────────

interface CreateFormProps { onSuccess: () => void; onCancel: () => void }

function CreateForm({ onSuccess, onCancel }: CreateFormProps) {
  const qc = useQueryClient()
  const [content,    setContent]    = useState('')
  const [type,       setType]       = useState<MemoryType>('observation')
  const [confidence, setConfidence] = useState(1.0)
  const [source,     setSource]     = useState('')
  const [tags,       setTags]       = useState('')
  const [expiresAt,  setExpiresAt]  = useState('')

  const mutation = useMutation({
    mutationFn: () => warRoomApi.createMemory({
      content,
      type,
      confidence,
      ...(source ? { source } : {}),
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      ...(expiresAt ? { expiresAt: new Date(expiresAt).getTime() } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memories'] })
      onSuccess()
    },
  })

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] p-5 mb-4">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">New Memory</h3>
      <div className="grid gap-3">
        {/* Content */}
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Content <span className="text-red-400">*</span></label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={4}
            placeholder="Enter memory content…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none outline-none focus:border-blue-500/50 transition-colors"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Type */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Type</label>
            <select
              value={type}
              onChange={e => setType(e.target.value as MemoryType)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50 transition-colors"
            >
              {MEMORY_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Confidence */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Confidence (0–1)</label>
            <input
              type="number"
              min={0} max={1} step={0.05}
              value={confidence}
              onChange={e => setConfidence(parseFloat(e.target.value) || 0)}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50 transition-colors"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Source */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Source</label>
            <input
              type="text"
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder="e.g. agent, user, api"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50 transition-colors"
            />
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Tags (comma-separated)</label>
            <input
              type="text"
              value={tags}
              onChange={e => setTags(e.target.value)}
              placeholder="tag1, tag2"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50 transition-colors"
            />
          </div>
        </div>

        {/* Expires */}
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Expires At (optional)</label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-blue-500/50 transition-colors"
          />
        </div>

        {mutation.isError && (
          <div className="flex items-center gap-2 text-red-400 text-xs">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {(mutation.error as Error).message}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!content.trim() || mutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-400 text-xs font-medium hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {mutation.isPending
              ? <><Loader2 className="w-3 h-3 animate-spin" />Saving…</>
              : <><CheckCircle className="w-3 h-3" />Save Memory</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Memory Card ──────────────────────────────────────────────────────────────

interface MemoryCardProps {
  memory: Memory
  expanded: boolean
  onToggle: () => void
  onMarkStale: () => void
  staling: boolean
}

const TRUNCATE_LEN = 180

function MemoryCard({ memory: m, expanded, onToggle, onMarkStale, staling }: MemoryCardProps) {
  const truncated  = m.content.length > TRUNCATE_LEN && !expanded
  const displayContent = truncated ? `${m.content.slice(0, TRUNCATE_LEN)}…` : m.content

  return (
    <div
      className={`rounded-xl border transition-colors ${
        m.isStale
          ? 'border-zinc-700/40 bg-[var(--bg-surface)] opacity-60'
          : 'border-[var(--border)] bg-[var(--bg-surface)]'
      }`}
    >
      {/* Header row */}
      <div
        className="flex items-start gap-3 p-4 cursor-pointer select-none"
        onClick={onToggle}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[var(--text-primary)] leading-relaxed break-words whitespace-pre-wrap">
            {displayContent}
          </p>
          {truncated && (
            <button
              type="button"
              className="mt-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              onClick={e => { e.stopPropagation(); onToggle() }}
            >
              Show more
            </button>
          )}
        </div>
        <div className="shrink-0 mt-0.5 text-[var(--text-muted)]">
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </div>

      {/* Meta row */}
      <div className="px-4 pb-3 flex flex-wrap items-center gap-2">
        <TypeBadge type={m.type} />
        {m.isStale && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border bg-zinc-500/10 text-zinc-500 border-zinc-500/20">
            stale
          </span>
        )}
        <div className="flex-1 min-w-[120px] max-w-[160px]">
          <ConfidenceBar value={m.confidence} />
        </div>
        {m.source && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">{m.source}</span>
        )}
      </div>

      {/* Tags */}
      {m.tags.length > 0 && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {m.tags.map(tag => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border)]"
            >
              <Tag className="w-2.5 h-2.5" />{tag}
            </span>
          ))}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-[var(--border)] pt-3 grid gap-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-[var(--text-muted)]">Created</span>
              <p className="text-[var(--text-secondary)] mt-0.5">{formatTs(m.createdAt)}</p>
              <p className="text-[10px] text-[var(--text-muted)]">{relativeTs(m.createdAt)}</p>
            </div>
            {m.expiresAt !== undefined && (
              <div>
                <span className="text-[var(--text-muted)]">Expires</span>
                <p className="text-[var(--text-secondary)] mt-0.5">{formatTs(m.expiresAt)}</p>
                <p className="text-[10px] text-[var(--text-muted)]">{relativeTs(m.expiresAt)}</p>
              </div>
            )}
          </div>
          {m.summary && (
            <div>
              <span className="text-xs text-[var(--text-muted)]">Summary</span>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">{m.summary}</p>
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onMarkStale}
              disabled={m.isStale || staling}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {staling ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
              {m.isStale ? 'Already stale' : 'Mark stale'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MemoryBrowserPage() {
  const qc = useQueryClient()

  // ── State ──
  const [search,      setSearch]      = useState('')
  const [typeFilter,  setTypeFilter]  = useState('all')
  const [page,        setPage]        = useState(0)
  const [showCreate,  setShowCreate]  = useState(false)
  const [expandedId,  setExpandedId]  = useState<string | null>(null)
  const [stalingIds,  setStalingIds]  = useState<Set<string>>(new Set())

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((val: string) => {
    setSearch(val)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(val)
      setPage(0)
    }, 300)
  }, [])
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // ── Query ──
  // Use searchMemory when there's a query, otherwise listMemories with pagination
  const isSearching = debouncedSearch.trim().length > 0

  const listQuery = useQuery({
    queryKey: ['memories', 'list', typeFilter, page],
    queryFn:  () => warRoomApi.listMemories({ limit: LIMIT, includeStale: true }),
    enabled:  !isSearching,
  })

  const searchQuery = useQuery({
    queryKey: ['memories', 'search', debouncedSearch],
    queryFn:  () => warRoomApi.searchMemory(debouncedSearch, { limit: 50 }),
    enabled:  isSearching,
  })

  // Compute displayed memories
  const rawMemories: Memory[] = isSearching
    ? (searchQuery.data?.data ?? [])
    : (listQuery.data?.data ?? [])

  const filtered = typeFilter === 'all'
    ? rawMemories
    : rawMemories.filter(m => m.type === typeFilter)

  // Client-side pagination for search results; server-side for list
  const paginatedMemories = isSearching
    ? filtered.slice(page * LIMIT, (page + 1) * LIMIT)
    : filtered

  const totalPages = Math.max(1, Math.ceil(filtered.length / LIMIT))
  const isLoading  = isSearching ? searchQuery.isLoading : listQuery.isLoading
  const isError    = isSearching ? searchQuery.isError   : listQuery.isError

  // ── Stale mutation ──
  const staleMutation = useMutation({
    mutationFn: (id: string) => warRoomApi.markMemoryStale(id),
    onMutate:   (id) => setStalingIds(s => new Set([...s, id])),
    onSettled:  (_, __, id) => {
      setStalingIds(s => { const n = new Set(s); n.delete(id); return n })
      void qc.invalidateQueries({ queryKey: ['memories'] })
    },
  })

  const handleMarkStale = useCallback((id: string) => { staleMutation.mutate(id) }, [staleMutation])

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }, [])

  const handleCreateSuccess = useCallback(() => {
    setShowCreate(false)
    setPage(0)
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--bg-primary)]">

      {/* ── Top bar ── */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-surface)] px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <Brain className="w-5 h-5 text-purple-400" />
            <h1 className="text-base font-semibold text-[var(--text-primary)]">Memory Browser</h1>
          </div>
          <button
            type="button"
            onClick={() => setShowCreate(v => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-400 text-xs font-medium hover:bg-blue-500/30 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Memory
          </button>
        </div>

        {/* ── Filters ── */}
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)] pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search memories…"
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-blue-500/50 transition-colors"
            />
            {search && (
              <button
                type="button"
                onClick={() => { handleSearchChange(''); setDebouncedSearch('') }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Type filter */}
          <select
            value={typeFilter}
            onChange={e => { setTypeFilter(e.target.value); setPage(0) }}
            className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-blue-500/50 transition-colors"
          >
            <option value="all">All types</option>
            {MEMORY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>

          {/* Count badge */}
          {!isLoading && (
            <span className="text-xs text-[var(--text-muted)]">
              {filtered.length} {filtered.length === 1 ? 'memory' : 'memories'}
            </span>
          )}
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-6 py-4">

        {/* Create form */}
        {showCreate && (
          <CreateForm
            onSuccess={handleCreateSuccess}
            onCancel={() => setShowCreate(false)}
          />
        )}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-20 text-[var(--text-muted)]">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Loading memories…</span>
          </div>
        )}

        {/* Error */}
        {isError && !isLoading && (
          <div className="flex items-center justify-center gap-2 py-20 text-red-400">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm">Failed to load memories</span>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && paginatedMemories.length === 0 && (
          <EmptyState search={debouncedSearch} typeFilter={typeFilter} />
        )}

        {/* Memory list */}
        {!isLoading && !isError && paginatedMemories.length > 0 && (
          <div className="grid gap-3">
            {paginatedMemories.map(m => (
              <MemoryCard
                key={m.id}
                memory={m}
                expanded={expandedId === m.id}
                onToggle={() => handleToggleExpand(m.id)}
                onMarkStale={() => handleMarkStale(m.id)}
                staling={stalingIds.has(m.id)}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {!isLoading && !isError && filtered.length > LIMIT && (
          <div className="flex items-center justify-center gap-3 pt-6 pb-2">
            <button
              type="button"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Prev
            </button>
            <span className="text-xs text-[var(--text-muted)]">
              Page {page + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Spacer */}
        <div className="h-4" />
      </div>
    </div>
  )
}
