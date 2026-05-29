/**
 * PageState — uniform loading / error / empty rendering for React Query
 * page-level fetches. Drop in where pages previously showed `null` or
 * a stale empty layout while loading.
 *
 * Usage:
 *   const q = useQuery(...)
 *   if (q.isPending) return <PageState kind="loading" label="…" />
 *   if (q.isError)   return <PageState kind="error" error={q.error} onRetry={() => q.refetch()} />
 *   if (!q.data)     return <PageState kind="empty" label="No data yet" />
 */
import { Loader2, AlertTriangle, Inbox, RefreshCcw } from 'lucide-react'

interface PageStateProps {
  kind:    'loading' | 'error' | 'empty'
  label?:  string
  error?:  unknown
  onRetry?: () => void
}

export function PageState({ kind, label, error, onRetry }: PageStateProps) {
  if (kind === 'loading') {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
        <div className="text-xs">{label ?? 'Loading…'}</div>
      </div>
    )
  }
  if (kind === 'error') {
    const msg = (error as Error | undefined)?.message ?? 'Something went wrong.'
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center gap-2 text-[var(--error)]">
        <AlertTriangle className="w-5 h-5" />
        <div className="text-xs max-w-md text-center">{msg}</div>
        {onRetry && (
          <button onClick={onRetry}
            className="mt-1 px-3 py-1 text-xs rounded border border-[var(--border)] hover:border-[var(--accent)] flex items-center gap-1 text-[var(--text-secondary)]">
            <RefreshCcw className="w-3 h-3" /> Retry
          </button>
        )}
      </div>
    )
  }
  // empty
  return (
    <div className="min-h-[30vh] flex flex-col items-center justify-center gap-2 text-[var(--text-muted)]">
      <Inbox className="w-5 h-5" />
      <div className="text-xs">{label ?? 'Nothing here yet.'}</div>
    </div>
  )
}
