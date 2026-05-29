/**
 * Timeline — full event timeline with type filtering and search.
 */
import { useState, useCallback, useEffect, useMemo }     from 'react'
import { useQuery, useQueryClient }                      from '@tanstack/react-query'
import { formatDistanceToNow, format }                   from 'date-fns'
import { Activity, Filter, Search, RefreshCw, ChevronDown, ChevronRight, Clock, Download } from 'lucide-react'
import { warRoomApi, API_BASE, type OpsEvent }            from '../api.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const EVENT_TYPES = [
  'All Types', 'workflow', 'approval', 'memory',
  'browser', 'recovery', 'anomaly', 'briefing', 'opportunity',
] as const

const TIME_WINDOWS = [
  { label: 'Last 1h',  ms: 60 * 60 * 1000 },
  { label: 'Last 6h',  ms: 6 * 60 * 60 * 1000 },
  { label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7d',  ms: 7 * 24 * 60 * 60 * 1000 },
]

// ─── Color logic ──────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, string> = {
  workflow:     '#3b82f6',
  approval:     '#f59e0b',
  memory:       '#a855f7',
  browser:      '#06b6d4',
  recovery:     '#f97316',
  anomaly:      '#ef4444',
  briefing:     '#10b981',
  opportunity:  '#6366f1',
  risk:         '#dc2626',
  insight:      '#8b5cf6',
  goal:         '#059669',
  agent:        '#0ea5e9',
  business:     '#d97706',
  scheduler:    '#7c3aed',
  dlq:          '#b45309',
  webhook:      '#0891b2',
  notification: '#c026d3',
  search:       '#64748b',
  brain_task:   '#14b8a6',
  issue:        '#fb7185',
}

function getEventColor(type: string): string {
  const prefix = type.split('.')[0] ?? type
  return COLOR_MAP[prefix.toLowerCase()] ?? '#6b7280'
}

function eventColor(type: string): { dot: string; badge: string } {
  const t = type.toLowerCase()
  if (t.startsWith('workflow'))                              return { dot: 'bg-blue-400',    badge: 'bg-blue-500/15 text-blue-400 border-blue-500/25' }
  if (t.startsWith('approval'))                             return { dot: 'bg-amber-400',   badge: 'bg-amber-500/15 text-amber-400 border-amber-500/25' }
  if (t.startsWith('memory'))                               return { dot: 'bg-purple-400',  badge: 'bg-purple-500/15 text-purple-400 border-purple-500/25' }
  if (t.startsWith('browser'))                              return { dot: 'bg-cyan-400',    badge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25' }
  if (t.startsWith('recovery') || t.startsWith('rollback')) return { dot: 'bg-orange-400', badge: 'bg-orange-500/15 text-orange-400 border-orange-500/25' }
  if (t.startsWith('anomaly') || t.startsWith('slo'))      return { dot: 'bg-red-400',     badge: 'bg-red-500/15 text-red-400 border-red-500/25' }
  if (t.startsWith('briefing'))                             return { dot: 'bg-emerald-400', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25' }
  if (t.startsWith('opportunity'))                          return { dot: 'bg-indigo-400',  badge: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25' }
  if (t.startsWith('risk'))                                 return { dot: 'bg-red-500',     badge: 'bg-red-600/15 text-red-400 border-red-600/25' }
  if (t.startsWith('insight'))                              return { dot: 'bg-violet-400',  badge: 'bg-violet-500/15 text-violet-400 border-violet-500/25' }
  if (t.startsWith('goal'))                                 return { dot: 'bg-emerald-500', badge: 'bg-emerald-600/15 text-emerald-400 border-emerald-600/25' }
  if (t.startsWith('brain_task'))                           return { dot: 'bg-teal-400',    badge: 'bg-teal-500/15 text-teal-400 border-teal-500/25' }
  if (t.startsWith('issue'))                                return { dot: 'bg-rose-400',    badge: 'bg-rose-500/15 text-rose-400 border-rose-500/25' }
  if (t.startsWith('agent'))                                return { dot: 'bg-sky-400',     badge: 'bg-sky-500/15 text-sky-400 border-sky-500/25' }
  if (t.startsWith('business'))                             return { dot: 'bg-amber-500',   badge: 'bg-amber-600/15 text-amber-400 border-amber-600/25' }
  if (t.startsWith('scheduler'))                            return { dot: 'bg-violet-500',  badge: 'bg-violet-600/15 text-violet-400 border-violet-600/25' }
  if (t.startsWith('dlq'))                                  return { dot: 'bg-yellow-700',  badge: 'bg-yellow-800/15 text-yellow-600 border-yellow-800/25' }
  if (t.startsWith('webhook'))                              return { dot: 'bg-cyan-600',    badge: 'bg-cyan-700/15 text-cyan-400 border-cyan-700/25' }
  if (t.startsWith('notification'))                         return { dot: 'bg-fuchsia-500', badge: 'bg-fuchsia-600/15 text-fuchsia-400 border-fuchsia-600/25' }
  if (t.startsWith('search'))                               return { dot: 'bg-slate-400',   badge: 'bg-slate-500/15 text-slate-400 border-slate-500/25' }
  return { dot: 'bg-zinc-400', badge: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25' }
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCsv(events: OpsEvent[]): void {
  const rows = [
    ['id', 'type', 'source', 'createdAt', 'payload'].join(','),
    ...events.map(e => [
      e.id,
      e.type,
      e.source,
      new Date(e.createdAt).toISOString(),
      JSON.stringify(e.payload ?? {}).replace(/,/g, ';'),
    ].join(',')),
  ]
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `events-${Date.now()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Event row ────────────────────────────────────────────────────────────────

function EventRow({ event: e }: { event: OpsEvent }) {
  const [expanded, setExpanded] = useState(false)
  const [showAbsolute, setShowAbsolute] = useState(false)
  const colors   = eventColor(e.type)
  const hexColor = getEventColor(e.type)

  const payloadPreview = (() => {
    try {
      const s = JSON.stringify(e.payload)
      return s.length > 120 ? s.slice(0, 120) + '…' : s
    } catch {
      return '(unparseable payload)'
    }
  })()

  const payloadFormatted = (() => {
    try {
      return JSON.stringify(e.payload, null, 2)
    } catch {
      return String(e.payload)
    }
  })()

  return (
    <li className="group hover:bg-elevated transition-colors">
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Timeline line + dot */}
        <div className="flex flex-col items-center mt-1 shrink-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${colors.dot}`} />
          {expanded && <div className="w-px flex-1 min-h-[8px] bg-[var(--border)] mt-1" />}
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded border font-mono shrink-0 ${colors.badge}`}
              style={{ borderColor: hexColor + '40' }}
            >
              {e.type}
            </span>
            <span className="text-xs text-muted shrink-0">
              {e.source}
            </span>
            <span className="text-xs text-muted shrink-0 font-mono">
              ·&nbsp;{e.traceId.slice(0, 8)}…
            </span>
            <span
              className="ml-auto text-xs text-muted tabular-nums shrink-0 cursor-default"
              title={format(e.createdAt, 'yyyy-MM-dd HH:mm:ss')}
              onMouseEnter={() => setShowAbsolute(true)}
              onMouseLeave={() => setShowAbsolute(false)}
              onClick={(ev) => ev.stopPropagation()}
            >
              {showAbsolute
                ? format(e.createdAt, 'HH:mm:ss')
                : formatDistanceToNow(e.createdAt, { addSuffix: true })}
            </span>
            <div className="shrink-0 text-muted">
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </div>
          </div>

          {/* Payload preview */}
          {!expanded && (
            <div className="mt-1 font-mono text-[10px] text-muted truncate">
              {payloadPreview}
            </div>
          )}
        </div>
      </div>

      {/* Expanded JSON */}
      {expanded && (
        <div className="mx-4 mb-3 rounded-lg border border-border bg-elevated overflow-auto max-h-64">
          <pre className="p-3 text-[10px] font-mono text-secondary leading-relaxed whitespace-pre-wrap break-all">
            {payloadFormatted}
          </pre>
        </div>
      )}
    </li>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="mt-1 w-2 h-2 rounded-full bg-elevated shrink-0 animate-pulse" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-4 w-24 rounded bg-elevated animate-pulse" />
          <div className="h-4 w-16 rounded bg-elevated animate-pulse" />
          <div className="ml-auto h-4 w-20 rounded bg-elevated animate-pulse" />
        </div>
        <div className="h-3 w-64 rounded bg-elevated animate-pulse" />
      </div>
    </li>
  )
}

// ─── Timeline page ────────────────────────────────────────────────────────────

export default function Timeline() {
  const qc = useQueryClient()
  const [search, setSearch]         = useState('')
  const [typeFilter, setTypeFilter] = useState<typeof EVENT_TYPES[number]>('All Types')
  const [windowIdx, setWindowIdx]   = useState(1) // default 6h
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const [liveEvents, setLiveEvents] = useState<OpsEvent[]>([])
  const [streaming, setStreaming]   = useState(false)

  const windowMs = TIME_WINDOWS[windowIdx]!.ms

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey:       ['timeline-events', windowIdx],
    queryFn:        () => warRoomApi.getEvents({ since: Date.now() - windowMs, limit: 200 }),
    refetchInterval: 10_000,
  })

  // SSE live events
  useEffect(() => {
    const token = localStorage.getItem('ops_token') ?? ''
    // Direct to API (skip Vite proxy) — proxied SSE leaks sockets across HMR.
    const es = new EventSource(`${API_BASE}/api/v1/stream?token=${encodeURIComponent(token)}`)
    setStreaming(true)

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data as string) as OpsEvent & { type: string }
        if (evt.type !== 'heartbeat') {
          setLiveEvents(prev => [evt, ...prev].slice(0, 100))
          void qc.invalidateQueries({ queryKey: ['timeline-events'] })
        }
      } catch { /* ignore parse errors */ }
    }

    es.onerror = () => setStreaming(false)

    return () => { es.close(); setStreaming(false) }
  }, [qc])

  const allEvents: OpsEvent[] = data?.data ?? []

  // Client-side filtering with useMemo
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allEvents.filter((e) => {
      const matchesType = typeFilter === 'All Types' || e.type.toLowerCase().startsWith(typeFilter)
      const matchesSearch = !q
        || e.type.toLowerCase().includes(q)
        || e.source.toLowerCase().includes(q)
        || e.traceId.toLowerCase().includes(q)
        || JSON.stringify(e.payload).toLowerCase().includes(q)
      return matchesType && matchesSearch
    })
  }, [allEvents, search, typeFilter])

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['timeline-events'] })
  }, [qc])

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg">

      {/* Header */}
      <header className="shrink-0 flex items-center justify-between px-6 py-3 border-b border-border bg-[var(--bg-surface)]">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
            <Clock className="w-3.5 h-3.5 text-blue-400" />
          </div>
          <div>
            <div className="text-sm font-semibold text-primary">Event Timeline</div>
            <div className="text-xs text-secondary">
              {isLoading ? 'Loading…' : `${filtered.length} of ${allEvents.length} events`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Streaming indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-elevated">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${streaming ? 'bg-green-400 animate-pulse' : 'bg-zinc-500'}`}
            />
            <span className="text-xs text-muted">
              {streaming ? 'Live' : 'Offline'}
            </span>
            {liveEvents.length > 0 && (
              <span className="text-xs font-medium text-green-400 tabular-nums">
                +{liveEvents.length} new
              </span>
            )}
          </div>

          {/* Export CSV */}
          <button
            onClick={() => exportCsv(filtered)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-secondary border border-border hover:bg-elevated transition-colors"
          >
            <Download className="w-3 h-3" />
            Export CSV
          </button>

          {/* Refresh */}
          <button
            onClick={refresh}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-secondary border border-border hover:bg-elevated disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-[var(--bg-surface)]">

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events…"
            className="w-full pl-7 pr-3 py-1.5 bg-elevated border border-border rounded-lg text-xs text-primary placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-500/40"
          />
        </div>

        {/* Type filter */}
        <div className="relative">
          <button
            onClick={() => setShowTypeMenu((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-elevated border border-border rounded-lg text-xs text-primary hover:bg-[var(--bg-surface)] transition-colors"
          >
            <Filter className="w-3 h-3 text-muted" />
            {typeFilter}
            <ChevronDown className="w-3 h-3 text-muted" />
          </button>
          {showTypeMenu && (
            <div className="absolute top-full mt-1 left-0 z-50 bg-[var(--bg-surface)] border border-border rounded-lg shadow-xl overflow-hidden min-w-[140px]">
              {EVENT_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => { setTypeFilter(t); setShowTypeMenu(false) }}
                  className={`w-full text-left px-3 py-2 text-xs transition-colors ${
                    typeFilter === t
                      ? 'bg-blue-500/15 text-blue-400'
                      : 'text-secondary hover:bg-elevated'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Time window */}
        <div className="flex items-center gap-1 ml-auto">
          {TIME_WINDOWS.map((w, i) => (
            <button
              key={w.label}
              onClick={() => setWindowIdx(i)}
              className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                windowIdx === i
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'text-muted hover:bg-elevated'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Last updated */}
        {dataUpdatedAt > 0 && (
          <span className="text-[10px] text-muted tabular-nums shrink-0">
            Updated {formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <ul className="divide-y divide-[var(--border)]">
            {Array.from({ length: 12 }).map((_, i) => <SkeletonRow key={i} />)}
          </ul>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted">
            <Activity className="w-8 h-8 opacity-30" />
            <div className="text-sm">
              {allEvents.length === 0
                ? 'No events in this time window'
                : 'No events match your filters'}
            </div>
            {(search || typeFilter !== 'All Types') && (
              <button
                onClick={() => { setSearch(''); setTypeFilter('All Types') }}
                className="text-xs px-3 py-1.5 rounded-lg border border-border text-secondary hover:bg-elevated transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {filtered.map((e) => <EventRow key={e.id} event={e} />)}
          </ul>
        )}
      </div>

      {/* Click-outside dismiss for type menu */}
      {showTypeMenu && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setShowTypeMenu(false)}
        />
      )}
    </div>
  )
}
