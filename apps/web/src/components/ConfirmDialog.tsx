import { clsx } from 'clsx'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

export function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
  danger,
}: ConfirmDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />
      {/* Dialog */}
      <div className="relative z-10 w-full max-w-sm mx-4 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] shadow-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
          <p className="text-xs text-[var(--text-secondary)]">{description}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={clsx(
              'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
              danger
                ? 'bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20'
                : 'bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--accent)] hover:bg-[var(--accent)]/20',
            )}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
