import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, AlertTriangle, XCircle, Info, Check, X, ExternalLink, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { notificationApi, type Notification as OpsNotif } from '../api'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_COLOR: Record<OpsNotif['type'], string> = {
  info:    '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  error:   '#ef4444',
}

const TYPE_ICON: Record<OpsNotif['type'], LucideIcon> = {
  info:    Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error:   XCircle,
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts * (ts < 1e12 ? 1000 : 1)) / 1000)
  if (diff < 60)    return `${diff}s ago`
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function dateLabel(ts: number): string {
  const d = new Date(ts * (ts < 1e12 ? 1000 : 1))
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString())     return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function groupByDate(items: OpsNotif[]): Array<[string, OpsNotif[]]> {
  const map = new Map<string, OpsNotif[]>()
  for (const n of items) {
    const label = dateLabel(n.createdAt)
    const arr = map.get(label) ?? []
    arr.push(n)
    map.set(label, arr)
  }
  return Array.from(map.entries())
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'all' | 'unread' | 'dismissed'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all',       label: 'All' },
  { id: 'unread',    label: 'Unread' },
  { id: 'dismissed', label: 'Dismissed' },
]

const PAGE_SIZE = 25

// ── OpsNotifRow ───────────────────────────────────────────────────────────

interface RowProps {
  n:          OpsNotif
  onMarkRead: (id: string) => void
  onDismiss:  (id: string) => void
}

function OpsNotifRow({ n, onMarkRead, onDismiss }: RowProps) {
  const navigate = useNavigate()
  const Icon  = TYPE_ICON[n.type]
  const color = TYPE_COLOR[n.type]

  return (
    <div
      className={`flex gap-4 px-5 py-4 border-b border-border last:border-0 transition-colors ${
        !n.read && !n.dismissed ? 'bg-blue-500/5' : ''
      }`}
    >
      <span className="mt-0.5 shrink-0">
        <Icon size={18} color={color} />
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <p className={`text-sm leading-snug ${!n.read && !n.dismissed ? 'font-semibold text-primary' : 'text-secondary'}`}>
            {n.title}
            {!n.read && !n.dismissed && (
              <span className="ml-2 inline-block w-2 h-2 rounded-full bg-blue-500 align-middle" />
            )}
          </p>
          <span className="text-xs text-muted shrink-0 mt-0.5">{timeAgo(n.createdAt)}</span>
        </div>
        <p className="text-xs text-muted mt-1 leading-relaxed">{n.body}</p>

        <div className="flex items-center gap-3 mt-2">
          {n.actionUrl && (
            <button
              onClick={() => navigate(n.actionUrl!)}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <ExternalLink size={11} />
              View
            </button>
          )}
          {!n.read && !n.dismissed && (
            <button
              onClick={() => onMarkRead(n.id)}
              className="flex items-center gap-1 text-xs text-muted hover:text-secondary transition-colors"
            >
              <Check size={11} />
              Mark read
            </button>
          )}
        </div>
      </div>

      {!n.dismissed && (
        <button
          onClick={() => onDismiss(n.id)}
          title="Dismiss"
          className="shrink-0 mt-0.5 p-1 rounded hover:bg-elevated text-muted hover:text-secondary transition-colors"
        >
          <X size={14} />
        </button>
      )}
    </div>
  )
}

// ── OpsNotifsPage ─────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const [tab, setTab] = useState<Tab>('all')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<OpsNotif[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const qc = useQueryClient()

  const listOpts = tab === 'all'
    ? { dismissed: false }
    : tab === 'unread'
    ? { read: false, dismissed: false }
    : { dismissed: true }

  // Fetch on tab/offset change
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    notificationApi.list({ ...listOpts, limit: PAGE_SIZE })
      .then((res) => {
        if (cancelled) return
        const page = res.data
        setItems((prev) => offset === 0 ? page : [...prev, ...page])
        setUnreadCount(res.meta.unreadCount)
        setHasMore(page.length === PAGE_SIZE)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tab, offset])

  // Reset offset on tab change
  function switchTab(next: Tab) {
    if (next === tab) return
    setTab(next)
    setOffset(0)
    setItems([])
  }

  const markRead = useMutation({
    mutationFn: (id: string) => notificationApi.markRead(id),
    onSuccess: (_, id) => {
      setItems((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n))
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const dismiss = useMutation({
    mutationFn: (id: string) => notificationApi.dismiss(id),
    onSuccess: (_, id) => {
      setItems((prev) =>
        tab === 'dismissed'
          ? prev.map((n) => n.id === id ? { ...n, dismissed: true } : n)
          : prev.filter((n) => n.id !== id)
      )
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const markAllRead = useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSuccess: () => {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })

  const groups = groupByDate(items)

  const emptyMessages: Record<Tab, string> = {
    all:       'No notifications yet.',
    unread:    'No unread notifications.',
    dismissed: 'No dismissed notifications.',
  }

  return (
    <div className="flex flex-col h-full bg-bg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <h1 className="text-lg font-semibold text-primary">OpsNotifs</h1>
        {unreadCount > 0 && (
          <button
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
          >
            <Check size={14} />
            Mark all read
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 px-6 py-2 border-b border-border shrink-0">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => switchTab(id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                : 'text-muted hover:bg-elevated hover:text-secondary'
            }`}
          >
            {label}
            {id === 'unread' && unreadCount > 0 && (
              <span className="ml-1.5 text-xs bg-blue-500 text-white rounded-full px-1.5 py-0.5">
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted text-sm">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-muted">
            <CheckCircle size={36} className="opacity-30" />
            <span className="text-sm">{emptyMessages[tab]}</span>
          </div>
        ) : (
          <div>
            {groups.map(([label, group]) => (
              <div key={label}>
                <div className="px-5 py-2 text-xs font-medium text-muted bg-[var(--bg-surface)] border-b border-border sticky top-0">
                  {label}
                </div>
                {group.map((n) => (
                  <OpsNotifRow
                    key={n.id}
                    n={n}
                    onMarkRead={(id) => markRead.mutate(id)}
                    onDismiss={(id) => dismiss.mutate(id)}
                  />
                ))}
              </div>
            ))}

            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={() => setOffset((o) => o + PAGE_SIZE)}
                  disabled={loading}
                  className="px-4 py-2 text-sm text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors border border-border rounded-lg hover:bg-elevated"
                >
                  {loading ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
