/**
 * OpsNotificationCenter — bell icon with dropdown panel showing recent notifications.
 * Place in the app header/sidebar.
 */
import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCircle, AlertTriangle, XCircle, Info, Check, type LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { notificationApi, type Notification as OpsNotif } from '../api'

// ── Type helpers ──────────────────────────────────────────────────────────────

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
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ── OpsNotificationItem ──────────────────────────────────────────────────────────

interface ItemProps {
  n: OpsNotif
  onRead: (id: string) => void
  navigate: ReturnType<typeof useNavigate>
}

function OpsNotificationItem({ n, onRead, navigate }: ItemProps) {
  const Icon = TYPE_ICON[n.type]
  const color = TYPE_COLOR[n.type]

  function handleClick() {
    if (!n.read) onRead(n.id)
    if (n.actionUrl) navigate(n.actionUrl)
  }

  return (
    <button
      onClick={handleClick}
      style={{ textAlign: 'left', width: '100%' }}
      className={`flex gap-3 px-4 py-3 hover:bg-[var(--bg-elevated)] transition-colors border-b border-[var(--border)] last:border-0 ${
        !n.read ? 'bg-blue-500/5' : ''
      }`}
    >
      <span className="mt-0.5 shrink-0">
        <Icon size={16} color={color} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm leading-snug truncate ${!n.read ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
            {n.title}
          </p>
          <span className="text-xs text-[var(--text-muted)] shrink-0 mt-0.5">
            {timeAgo(n.createdAt)}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-0.5 line-clamp-2">{n.body}</p>
      </div>
      {!n.read && (
        <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-blue-500" />
      )}
    </button>
  )
}

// ── OpsNotificationCenter ────────────────────────────────────────────────────────

export function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()

  // Poll every 30s
  const { data } = useQuery({
    queryKey: ['notifications', 'header'],
    queryFn: () => notificationApi.list({ dismissed: false, limit: 20 }),
    refetchInterval: 30_000,
  })

  const notifications = data?.data ?? []
  const unread = data?.meta.unreadCount ?? 0

  const markRead = useMutation({
    mutationFn: (id: string) => notificationApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  const markAllRead = useMutation({
    mutationFn: () => notificationApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Bell button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-9 h-9 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-secondary)] transition-colors"
        title="Notifications"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[14px] h-[14px] bg-red-500 rounded-full flex items-center justify-center text-[10px] font-bold text-white px-0.5"
            aria-hidden
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 380,
            maxHeight: 500,
            zIndex: 100,
          }}
          className="flex flex-col rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] shrink-0">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Notifications</span>
            {unread > 0 && (
              <button
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors"
              >
                <Check size={12} />
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-[var(--text-muted)]">
                <CheckCircle size={28} className="opacity-40" />
                <span className="text-sm">All caught up!</span>
              </div>
            ) : (
              notifications.map((n) => (
                <OpsNotificationItem
                  key={n.id}
                  n={n}
                  onRead={(id) => markRead.mutate(id)}
                  navigate={navigate}
                />
              ))
            )}
          </div>

          {/* Footer */}
          <div className="shrink-0 border-t border-[var(--border)] px-4 py-2">
            <button
              onClick={() => { setOpen(false); navigate('/notifications') }}
              className="w-full text-xs text-center text-blue-400 hover:text-blue-300 transition-colors py-1"
            >
              View all notifications →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
