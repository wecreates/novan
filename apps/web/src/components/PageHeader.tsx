import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  breadcrumb?: string
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: PageHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="flex flex-col gap-0.5">
        {breadcrumb && (
          <div className="text-xs text-[var(--text-muted)] font-medium uppercase tracking-wider mb-1">
            {breadcrumb}
          </div>
        )}
        <h1 className="text-xl font-semibold text-[var(--text-primary)] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-[var(--text-secondary)]">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  )
}
