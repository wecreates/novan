import { clsx } from 'clsx'
import type { ReactNode } from 'react'

interface Props {
  title:      string
  subtitle?:  string
  actions?:   ReactNode
  children:   ReactNode
  className?: string
  loading?:   boolean
}

export function SectionPanel({ title, subtitle, actions, children, className, loading }: Props) {
  return (
    <div className={clsx(
      'rounded-xl border border-[var(--border)] bg-[var(--bg-surface)] flex flex-col',
      className,
    )}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div>
          <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
          {subtitle && (
            <div className="text-xs text-[var(--text-secondary)] mt-0.5">{subtitle}</div>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-[var(--text-muted)] text-sm">
            Loading…
          </div>
        ) : children}
      </div>
    </div>
  )
}
