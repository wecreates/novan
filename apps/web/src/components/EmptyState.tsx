import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center gap-4">
      {icon && (
        <div className="text-4xl text-[var(--text-muted)] opacity-60">
          {icon}
        </div>
      )}
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        {description && (
          <p className="text-xs text-[var(--text-secondary)] max-w-sm">{description}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
