/**
 * components.tsx — Reusable premium UI primitives.
 *
 * Built on the design tokens in index.css + tokens.ts.
 * Used by BrainPage and any new page that wants the spatial language.
 */
import React from 'react'
import { ChevronDown, X } from 'lucide-react'
import { STATUS_PILL, STATUS_DOT } from './tokens.js'

// ─── GlassPanel ─────────────────────────────────────────────────────────

export function GlassPanel({
  children, className = '', strong = false, padding = 'p-4',
}: {
  children: React.ReactNode
  className?: string
  strong?: boolean
  padding?: string
}) {
  return (
    <div className={`${strong ? 'glass-strong' : 'glass'} rounded-lg ${padding} ${className}`}>
      {children}
    </div>
  )
}

// ─── StatusPill ────────────────────────────────────────────────────────

export function StatusPill({ status, children }: { status: string; children?: React.ReactNode }) {
  const cls = STATUS_PILL[status] ?? 'pill pill-muted'
  return <span className={cls}>{children ?? status}</span>
}

export function StatusDot({ status, className = '' }: { status: string; className?: string }) {
  const cls = STATUS_DOT[status] ?? 'dot dot-muted'
  return <span className={`${cls} ${className}`} />
}

// ─── Dropdown ─────────────────────────────────────────────────────────

export function Dropdown<T extends string>({
  label, icon, options, value, onChange, align = 'left',
}: {
  label?: string
  icon?: React.ReactNode
  options: Array<{ id: T; label: string; hint?: string }>
  value: T
  onChange: (v: T) => void
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = React.useState(false)
  const cur = options.find(o => o.id === value)
  const ref = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', fn)
    return () => window.removeEventListener('mousedown', fn)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(s => !s)}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs border border-border hover:bg-[var(--surface-hover)] transition-colors duration-fast ease-out">
        {icon}
        {label && <span className="text-muted">{label}:</span>}
        <span className="text-primary font-mono">{cur?.label ?? value}</span>
        <ChevronDown className="w-3 h-3 text-muted" />
      </button>
      {open && (
        <div className={`absolute top-full mt-1 ${align === 'right' ? 'right-0' : 'left-0'} dropdown-in panel-elevated min-w-[160px] z-dropdown overflow-hidden`}>
          {options.map(o => (
            <button key={o.id}
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] transition-colors duration-fast ${
                value === o.id ? 'text-healthy' : 'text-primary'
              }`}>
              <div>{o.label}</div>
              {o.hint && <div className="text-[10px] text-muted mt-0.5">{o.hint}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Drawer (right-edge floating glass) ───────────────────────────────

export function Drawer({
  title, subtitle, statusIcon, onClose, children, width = 320,
}: {
  title: string
  subtitle?: string
  statusIcon?: React.ReactNode
  onClose?: () => void
  children: React.ReactNode
  width?: number
}) {
  return (
    <div className="absolute top-3 right-3 drawer-edge slide-from-right z-drawer overflow-y-auto"
      style={{ width, maxHeight: 'calc(100vh - 6rem)' }}>
      <div className="px-4 py-3 flex items-start gap-3 border-b border-border">
        {statusIcon}
        <div className="flex-1 min-w-0">
          {subtitle && <div className="label">{subtitle}</div>}
          <div className="heading truncate">{title}</div>
        </div>
        {onClose && (
          <button onClick={onClose} className="btn-ghost btn p-1 -mr-1">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

// ─── KeyValue grid (for compact detail fields) ─────────────────────────

export function KV({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="label">{k}</span>
      <span className={`text-sm text-primary truncate ${mono ? 'mono' : ''}`}>{v}</span>
    </div>
  )
}

// ─── Section header (used inside drawers/panels) ──────────────────────

export function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-2 mt-3 first:mt-0">
      <span className="label flex-1">{children}</span>
      {action}
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────

export function Empty({ msg, hint }: { msg: string; hint?: string }) {
  return (
    <div className="px-4 py-6 text-center">
      <p className="text-xs text-muted italic">{msg}</p>
      {hint && <p className="text-[10px] text-faint mt-1">{hint}</p>}
    </div>
  )
}

// ─── Skeleton (calm shimmer) ──────────────────────────────────────────

export function Skeleton({ h = 16, className = '' }: { h?: number; className?: string }) {
  return <div className={`shimmer rounded ${className}`} style={{ height: h }} />
}

// ─── Top command bar (used by Brain + future pages) ──────────────────

export function CommandBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="glass border-b border-border px-4 py-2 flex items-center gap-3 text-xs z-overlay relative">
      {children}
    </div>
  )
}
