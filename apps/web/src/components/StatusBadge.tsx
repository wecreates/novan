import { clsx } from 'clsx'

type Status = 'green' | 'yellow' | 'orange' | 'red' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | string

const STATUS_STYLES: Record<string, string> = {
  green:              'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  yellow:             'bg-amber-500/10   text-amber-400   border-amber-500/20',
  orange:             'bg-orange-500/10  text-orange-400  border-orange-500/20',
  red:                'bg-red-500/10     text-red-400     border-red-500/20',
  pending:            'bg-zinc-500/10    text-zinc-400    border-zinc-500/20',
  running:            'bg-blue-500/10    text-blue-400    border-blue-500/20',
  completed:          'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  failed:             'bg-red-500/10     text-red-400     border-red-500/20',
  cancelled:          'bg-zinc-500/10    text-zinc-400    border-zinc-500/20',
  paused:             'bg-amber-500/10   text-amber-400   border-amber-500/20',
  awaiting_approval:  'bg-violet-500/10  text-violet-400  border-violet-500/20',
  identified:         'bg-zinc-500/10    text-zinc-400    border-zinc-500/20',
  active:             'bg-blue-500/10    text-blue-400    border-blue-500/20',
  low:                'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  medium:             'bg-amber-500/10   text-amber-400   border-amber-500/20',
  high:               'bg-orange-500/10  text-orange-400  border-orange-500/20',
  critical:           'bg-red-500/10     text-red-400     border-red-500/20',
}

interface Props {
  status: Status
  label?: string
  pulse?: boolean
  className?: string
}

export function StatusBadge({ status, label, pulse, className }: Props) {
  const style = STATUS_STYLES[status] ?? 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'

  return (
    <span className={clsx(
      'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border',
      style,
      className,
    )}>
      {pulse && (
        <span className={clsx(
          'relative flex h-1.5 w-1.5',
          status === 'running' && 'animate-pulse',
        )}>
          <span className="rounded-full bg-current h-full w-full" />
        </span>
      )}
      {label ?? status}
    </span>
  )
}
